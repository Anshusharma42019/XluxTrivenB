import OrderChain from './orderChain.model.js';
import FollowupCommissionSettings from './followupCommissionSettings.model.js';
import { createFirstOrderCredit, createRepeatOrderCommissionSplit } from './commissionRecord.service.js';
import { logAction } from './auditLog.service.js';

/**
 * orderChain.service.js
 * ---------------------
 * Core orchestrator for the commission workflow.
 *
 * WORKFLOW:
 *   Step 1 — First order submitted to verification:
 *     → appendOrderChain({ ..., orderType: 'first' })
 *     → Creates OrderChain entry (chain_seq = 1, self_hash computed)
 *     → Logs 'chain_entry_created' + 'submitter_locked'
 *     → Creates a pending CommissionRecord (first-order credit)
 *
 *   Step 2 — Repeat order submitted to verification:
 *     → appendOrderChain({ ..., orderType: 'repeat' })
 *     → Creates OrderChain entry (chain_seq = N+1, prev_hash = previous entry's self_hash)
 *     → Logs 'chain_entry_created' + 'submitter_locked'
 *     → Reads first-order chain entry to get originalSubmitterId
 *     → Calls createRepeatOrderCommissionSplit() → 2 CommissionRecord rows
 *     → Logs 'commission_split_calculated'
 */

/**
 * Append a new entry to the customer's order chain.
 *
 * This is the SINGLE entry point that must be called whenever an order
 * enters the verification workflow. It is idempotent: if a chain entry
 * already exists for the given (lead_id, order_id) pair it returns the
 * existing entry without duplicating records.
 *
 * @param {object} params
 * @param {ObjectId|string} params.leadId        — Lead._id linking all orders for this customer
 * @param {ObjectId|string} params.orderId       — The order being submitted (may be null for task-only flows)
 * @param {string}          params.orderModel    — 'ShiprocketOrder' | 'ShipmaxxOrder'
 * @param {ObjectId|string} params.submitterId   — req.user._id — LOCKED on insert, never changed
 * @param {'first'|'repeat'} params.orderType
 * @param {number}          [params.orderSubTotal]
 * @param {object}          params.actor         — req.user (for audit log)
 * @param {Date}            [params.deliveredAt]
 * @returns {Promise<{ chainEntry: OrderChain, isNew: boolean }>}
 */
export const appendOrderChain = async ({
  leadId,
  orderId,
  orderModel = 'ShiprocketOrder',
  submitterId,
  orderType,
  orderSubTotal = 0,
  actor,
  deliveredAt,
}) => {
  // ── Idempotency check: return existing entry if already recorded ──────────
  if (orderId) {
    const existing = await OrderChain.findOne({ lead_id: leadId, order_id: orderId }).lean();
    if (existing) {
      return { chainEntry: existing, isNew: false };
    }
  }

  // ── Fetch active commission settings ──────────────────────────────────────
  const settings = await FollowupCommissionSettings.findOne().sort({ createdAt: -1 }).lean();
  if (!settings || !settings.is_active) {
    console.warn('[OrderChain] Commission settings missing or inactive — chain entry skipped.');
    return { chainEntry: null, isNew: false };
  }
  const ruleVersion = settings.version || 'v1.0';

  // ── Determine next chain_seq and prev_hash for this customer ──────────────
  const lastEntry = await OrderChain.findOne({ lead_id: leadId })
    .sort({ chain_seq: -1 })
    .lean();

  const chain_seq = lastEntry ? lastEntry.chain_seq + 1 : 1;
  const prev_hash = lastEntry ? lastEntry.self_hash : OrderChain.GENESIS_HASH;

  // ── Compute self_hash ────────────────────────────────────────────────────
  const self_hash = OrderChain.computeHash({
    lead_id:      leadId,
    chain_seq,
    submitter_id: submitterId,
    order_id:     orderId,
    order_type:   orderType,
    prev_hash,
  });

  // ── Insert the immutable chain entry ─────────────────────────────────────
  const chainEntry = await OrderChain.create({
    lead_id:      leadId,
    order_id:     orderId    || null,
    order_model:  orderModel,
    chain_seq,
    submitter_id: submitterId,
    order_type:   orderType,
    rule_version: ruleVersion,
    prev_hash,
    self_hash,
  });

  // ── Audit: chain entry created + submitter locked ─────────────────────────
  await logAction({
    actor,
    action:      'chain_entry_created',
    entityType:  'OrderChain',
    entityId:    chainEntry._id,
    ruleVersion,
    after:       chainEntry.toObject(),
    meta:        { leadId, orderId, orderType, chain_seq },
  });
  await logAction({
    actor,
    action:      'submitter_locked',
    entityType:  'OrderChain',
    entityId:    chainEntry._id,
    ruleVersion,
    after:       { submitter_id: submitterId, locked_at: chainEntry.createdAt },
    meta:        { leadId, orderId, chain_seq },
  });

  // ── Commission logic based on order type ─────────────────────────────────
  if (orderType === 'first') {
    // First order: create a pending credit row for the original salesperson.
    await createFirstOrderCredit({
      chainEntryId:  chainEntry._id,
      orderId:       orderId    || null,
      orderModel,
      leadId,
      submitterId,
      orderSubTotal,
      settings,
      actor,
      deliveredAt,
    });

  } else if (orderType === 'repeat') {
    // Repeat order: find the original salesperson from the first chain entry.
    const firstEntry = await OrderChain.findOne({ lead_id: leadId, order_type: 'first' })
      .sort({ chain_seq: 1 })
      .lean();

    if (!firstEntry) {
      console.warn('[OrderChain] Repeat order — no first entry found for lead', leadId, '. Commission split skipped.');
    } else {
      await createRepeatOrderCommissionSplit({
        chainEntryId:        chainEntry._id,
        orderId:             orderId    || null,
        orderModel,
        leadId,
        originalSubmitterId: firstEntry.submitter_id,
        repeatSubmitterId:   submitterId,
        orderSubTotal,
        settings,
        actor,
        deliveredAt,
      });
    }
  }

  return { chainEntry, isNew: true };
};

/**
 * Retrieve the full order chain for a customer (lead), sorted chronologically.
 * Includes populated submitter details and associated commission records.
 *
 * @param {ObjectId|string} leadId
 * @returns {Promise<OrderChain[]>}
 */
export const getOrderChain = async (leadId) => {
  const CommissionRecord = (await import('./commissionRecord.model.js')).default;

  const entries = await OrderChain.find({ lead_id: leadId })
    .populate('submitter_id', 'name role')
    .populate('order_id')
    .sort({ chain_seq: 1 })
    .lean();

  if (!entries.length) return [];

  // Attach commission records to each chain entry
  const entryIds = entries.map(e => e._id);
  const commissions = await CommissionRecord.find({ chain_entry_id: { $in: entryIds } })
    .populate('staff_id', 'name role')
    .lean();

  const commMap = {};
  for (const c of commissions) {
    const key = String(c.chain_entry_id);
    if (!commMap[key]) commMap[key] = [];
    commMap[key].push(c);
  }

  return entries.map(e => ({
    ...e,
    commissions: commMap[String(e._id)] || [],
  }));
};

/**
 * Verify the integrity of a customer's order chain by re-computing hashes.
 *
 * @param {ObjectId|string} leadId
 * @returns {Promise<{ valid: boolean, errors: string[] }>}
 */
export const verifyChainIntegrity = async (leadId) => {
  const entries = await OrderChain.find({ lead_id: leadId }).sort({ chain_seq: 1 }).lean();
  const errors  = [];

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];

    // 1. Verify self_hash
    const expected = OrderChain.computeHash({
      lead_id:      e.lead_id,
      chain_seq:    e.chain_seq,
      submitter_id: e.submitter_id,
      order_id:     e.order_id,
      order_type:   e.order_type,
      prev_hash:    e.prev_hash,
    });
    if (e.self_hash !== expected) {
      errors.push(`Entry seq=${e.chain_seq} (_id=${e._id}): self_hash mismatch — possible tampering detected.`);
    }

    // 2. Verify prev_hash linkage
    if (i === 0) {
      if (e.prev_hash !== OrderChain.GENESIS_HASH) {
        errors.push(`Entry seq=1 (_id=${e._id}): prev_hash should be genesis hash but is '${e.prev_hash}'.`);
      }
    } else {
      const prev = entries[i - 1];
      if (e.prev_hash !== prev.self_hash) {
        errors.push(`Entry seq=${e.chain_seq} (_id=${e._id}): prev_hash does not match previous entry's self_hash.`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
};

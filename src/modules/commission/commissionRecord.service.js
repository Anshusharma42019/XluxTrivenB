import CommissionRecord from './commissionRecord.model.js';
import { logAction } from './auditLog.service.js';

/**
 * commissionRecord.service.js
 * ---------------------------
 * Pure service functions for the immutable commission ledger.
 *
 * All functions are INSERT-only — no existing row is ever mutated.
 * Corrections are handled via createReversal().
 */

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the commission amount for one role (original or reorder) using the
 * active settings document at the time of the commission calculation.
 *
 * @param {'original'|'reorder'} role
 * @param {number} orderSubTotal
 * @param {object} settings  — full FollowupCommissionSettings lean doc
 * @returns {number}
 */
export const calcCommissionAmount = (role, orderSubTotal, settings) => {
  const price = orderSubTotal || 0;

  // Find the matching price slab (if any)
  const slab = (settings.price_slabs || []).find(
    s => price >= s.min_price && (s.max_price == null || price <= s.max_price)
  );
  const src = slab || settings; // fall back to global settings if no slab matches

  const isOriginal = role === 'original';
  const flatAmt  = isOriginal ? src.original_staff_commission_amount  : src.reorder_commission_amount;
  const pctAmt   = isOriginal ? src.original_staff_commission_percent : src.reorder_commission_percent;

  return settings.commission_type === 'percent'
    ? Math.round((price * (pctAmt || 0)) / 100)
    : (flatAmt || 0);
};

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create commission records for a FIRST order (100% credit to the submitter).
 *
 * Called when a first-order chain entry is inserted.
 * No commission is paid out until a repeat order arrives — this creates
 * the "pending original credit" row so the chain is complete from the start.
 *
 * @param {object} params
 * @param {ObjectId} params.chainEntryId
 * @param {ObjectId} params.orderId
 * @param {string}   params.orderModel   — 'ShiprocketOrder' | 'ShipmaxxOrder'
 * @param {ObjectId} params.leadId
 * @param {ObjectId} params.submitterId  — the salesperson who created the first order
 * @param {number}   params.orderSubTotal
 * @param {object}   params.settings     — lean FollowupCommissionSettings doc
 * @param {object}   params.actor        — req.user who triggered this
 * @param {Date}     [params.deliveredAt]
 * @returns {Promise<CommissionRecord>}
 */
export const createFirstOrderCredit = async ({
  chainEntryId,
  orderId,
  orderModel,
  leadId,
  submitterId,
  orderSubTotal,
  settings,
  actor,
  deliveredAt,
}) => {
  const now       = deliveredAt || new Date();
  const month     = now.getMonth();
  const year      = now.getFullYear();
  const ruleVer   = settings?.version || 'v1.0';
  const amount    = calcCommissionAmount('original', orderSubTotal, settings);

  const record = await CommissionRecord.create({
    chain_entry_id:    chainEntryId,
    order_id:          orderId,
    order_model:       orderModel,
    lead_id:           leadId,
    staff_id:          submitterId,
    commission_role:   'original',
    commission_amount: amount,
    commission_type:   settings.commission_type || 'flat',
    order_sub_total:   orderSubTotal,
    rule_version:      ruleVer,
    rule_snapshot:     settings,
    entry_type:        'credit',
    status:            'pending',
    month,
    year,
    note:              'First order — 100% credit to original salesperson (pending repeat order)',
  });

  // Audit trail
  await logAction({
    actor,
    action:      'commission_first_order_credit',
    entityType:  'CommissionRecord',
    entityId:    record._id,
    ruleVersion: ruleVer,
    after:       record.toObject(),
    meta:        { orderId, leadId, submitterId, amount },
  });

  return record;
};

/**
 * Calculate and insert the 50-50 commission split for a REPEAT order.
 *
 * Creates exactly two CommissionRecord rows:
 *   1. 'original' → originalSubmitterId (from the first order's OrderChain entry)
 *   2. 'reorder'  → repeatSubmitterId   (whoever submitted the repeat order)
 *
 * Idempotent: uses findOneAndUpdate with $setOnInsert to avoid duplicates if
 * called more than once for the same order+role pair.
 *
 * @param {object} params
 * @param {ObjectId} params.chainEntryId       — OrderChain entry for the REPEAT order
 * @param {ObjectId} params.orderId
 * @param {string}   params.orderModel
 * @param {ObjectId} params.leadId
 * @param {ObjectId} params.originalSubmitterId — submitter_id from the FIRST OrderChain entry
 * @param {ObjectId} params.repeatSubmitterId   — submitter_id from the REPEAT OrderChain entry
 * @param {number}   params.orderSubTotal
 * @param {object}   params.settings
 * @param {object}   params.actor
 * @param {Date}     [params.deliveredAt]
 * @returns {Promise<{ original: CommissionRecord, reorder: CommissionRecord }>}
 */
export const createRepeatOrderCommissionSplit = async ({
  chainEntryId,
  orderId,
  orderModel,
  leadId,
  originalSubmitterId,
  repeatSubmitterId,
  orderSubTotal,
  settings,
  actor,
  deliveredAt,
}) => {
  const now     = deliveredAt || new Date();
  const month   = now.getMonth();
  const year    = now.getFullYear();
  const ruleVer = settings?.version || 'v1.0';

  const base = {
    chain_entry_id:  chainEntryId,
    order_id:        orderId,
    order_model:     orderModel,
    lead_id:         leadId,
    commission_type: settings.commission_type || 'flat',
    order_sub_total: orderSubTotal,
    rule_version:    ruleVer,
    rule_snapshot:   settings,
    entry_type:      'credit',
    status:          'pending',
    month,
    year,
  };

  const amountOriginal = calcCommissionAmount('original', orderSubTotal, settings);
  const amountReorder  = calcCommissionAmount('reorder',  orderSubTotal, settings);

  // Idempotent upserts — only insert if the pair (order_id + commission_role + entry_type) doesn't exist
  const [originalRecord, reorderRecord] = await Promise.all([
    CommissionRecord.findOneAndUpdate(
      { chain_entry_id: chainEntryId, commission_role: 'original', entry_type: 'credit' },
      {
        $setOnInsert: {
          ...base,
          staff_id:          originalSubmitterId,
          commission_role:   'original',
          commission_amount: amountOriginal,
          note:              'Repeat order — 50% commission credit to original salesperson (first order submitter)',
        },
      },
      { upsert: true, returnDocument: 'after' }
    ),
    CommissionRecord.findOneAndUpdate(
      { chain_entry_id: chainEntryId, commission_role: 'reorder', entry_type: 'credit' },
      {
        $setOnInsert: {
          ...base,
          staff_id:          repeatSubmitterId,
          commission_role:   'reorder',
          commission_amount: amountReorder,
          note:              'Repeat order — 50% commission credit to repeat order submitter',
        },
      },
      { upsert: true, returnDocument: 'after' }
    ),
  ]);

  // Audit trail
  await logAction({
    actor,
    action:      'commission_split_calculated',
    entityType:  'CommissionRecord',
    entityId:    chainEntryId,
    ruleVersion: ruleVer,
    after:       {
      original: { staffId: originalSubmitterId, amount: amountOriginal },
      reorder:  { staffId: repeatSubmitterId,   amount: amountReorder  },
    },
    meta: { orderId, leadId, orderSubTotal, settings: { version: ruleVer } },
  });

  return { original: originalRecord, reorder: reorderRecord };
};

/**
 * Insert a REVERSAL row to correct a previous commission record.
 *
 * The reversal row carries a negative amount equal to the original's amount,
 * so net balance calculations (SUM of all credit + reversal rows) remain accurate.
 *
 * @param {object} params
 * @param {ObjectId|string} params.commissionId  — the CommissionRecord to reverse
 * @param {object}          params.actor         — req.user performing the correction
 * @param {string}          [params.note]        — reason for reversal
 * @returns {Promise<CommissionRecord>}
 */
export const createReversal = async ({ commissionId, actor, note = '' }) => {
  const original = await CommissionRecord.findById(commissionId).lean();
  if (!original) throw new Error(`CommissionRecord ${commissionId} not found`);
  if (original.entry_type === 'reversal') throw new Error('Cannot reverse a reversal row');

  const reversal = await CommissionRecord.create({
    chain_entry_id:    original.chain_entry_id,
    order_id:          original.order_id,
    order_model:       original.order_model,
    lead_id:           original.lead_id,
    staff_id:          original.staff_id,
    commission_role:   original.commission_role,
    commission_amount: -Math.abs(original.commission_amount), // always negative
    commission_type:   original.commission_type,
    order_sub_total:   original.order_sub_total,
    rule_version:      original.rule_version,
    rule_snapshot:     original.rule_snapshot,
    entry_type:        'reversal',
    reversal_of:       original._id,
    status:            'pending',
    month:             original.month,
    year:              original.year,
    note:              note || `Reversal of commission ${original._id}`,
  });

  await logAction({
    actor,
    action:      'commission_reversed',
    entityType:  'CommissionRecord',
    entityId:    reversal._id,
    ruleVersion: original.rule_version,
    before:      original,
    after:       reversal.toObject(),
    meta:        { originalId: original._id, reason: note },
  });

  return reversal;
};

import mongoose from 'mongoose';
import User from '../user/user.model.js';
import { Lead } from '../lead/lead.model.js';
import Task from '../task/task.model.js';
import { Order } from '../shiprocket/models/order.model.js';
import { ShipmaxxOrder } from '../shipmaxx/models/shipmaxxOrder.model.js';
import { Return } from '../shiprocket/models/return.model.js';
import { ShipmaxxRtoOrder } from '../shipmaxx/models/shipmaxxRtoOrder.model.js';
import Verification from '../verification/verification.model.js';
import ReadyToShipment from '../readytoshipment/readytoshipment.model.js';
import { NdrNote } from '../shiprocket/models/ndrNote.model.js';
import { sendWhatsAppMessage } from '../interakt/interakt.service.js';
import { InvoiceHistory } from './invoiceHistory.model.js';

/* ─── IST helpers ──────────────────────────────────────────────────────────── */
const IST = 5.5 * 60 * 60 * 1000;

function buildDateRange(preset, from, to) {
  const now    = new Date();
  const istNow = new Date(now.getTime() + IST);
  const y = istNow.getUTCFullYear();
  const m = istNow.getUTCMonth();

  if (preset === 'today')  return { start: new Date(`${istNow.toISOString().slice(0, 10)}T00:00:00.000+05:30`), end: new Date(`${istNow.toISOString().slice(0, 10)}T23:59:59.999+05:30`) };
  if (preset === 'yesterday') {
    const yest = new Date(istNow.getTime() - 86400000);
    return { start: new Date(`${yest.toISOString().slice(0, 10)}T00:00:00.000+05:30`), end: new Date(`${yest.toISOString().slice(0, 10)}T23:59:59.999+05:30`) };
  }
  if (preset === 'last7' || preset === 'weekly') {
    const d7 = new Date(istNow.getTime() - 6 * 86400000);
    return {
      start: new Date(`${d7.toISOString().slice(0, 10)}T00:00:00.000+05:30`),
      end: new Date(`${istNow.toISOString().slice(0, 10)}T23:59:59.999+05:30`)
    };
  }
  if (preset === 'month' || preset === 'mtd')    return { start: new Date(Date.UTC(y, m, 1) - IST), end: now };
  if (preset === 'last_month') {
    const startLast = new Date(Date.UTC(y, m - 1, 1) - IST);
    const endLast = new Date(Date.UTC(y, m, 1) - IST - 1);
    return { start: startLast, end: endLast };
  }
  if (preset === 'all') return { start: new Date(0), end: now };
  if (preset === 'qtd')    return { start: new Date(Date.UTC(y, Math.floor(m / 3) * 3, 1) - IST), end: now };
  
  if (from && to)          return { start: new Date(`${from}T00:00:00.000+05:30`), end: new Date(`${to}T23:59:59.999+05:30`) };
  return { start: new Date(Date.UTC(y, m, 1) - IST), end: now };
}

function buildPrevRange(start, end) {
  const diff = end.getTime() - start.getTime();
  return { start: new Date(start.getTime() - diff), end: new Date(start.getTime() - 1) };
}

/* ══════════════════════════════════════════════════════════════════════════════
   Staff scoping: find all lead_ids that a staff member verified
   Orders are linked to staff via: Verification.assignedTo → Verification.lead → Order.lead_id
   Also covers orders where created_by / verified_by is set directly
══════════════════════════════════════════════════════════════════════════════ */
async function getStaffScope(staffId) {
  if (!staffId) return null; // null = no scope (admin/manager)
  const id = new mongoose.Types.ObjectId(staffId);
  const user = await mongoose.model('User').findById(id).select('role').lean();
  const isSales = user?.role === 'sales';

  if (isSales) {
    const leads = await mongoose.model('Lead').find({ assignedTo: id }, { _id: 1 }).lean();
    const verifications = await mongoose.model('Verification').find({ $or: [{ verifiedBy: id }, { assignedTo: id }] }, { _id: 1 }).lean();
    return {
      isSales: true,
      leadIds: leads.map(l => l._id),
      verificationIds: verifications.map(v => v._id)
    };
  }

  const verifications = await mongoose.model('Verification').find({ $or: [{ verifiedBy: id }, { assignedTo: id }] }, { lead: 1, _id: 1 }).lean();
  const leads = await mongoose.model('Lead').find({ assignedTo: id }, { _id: 1 }).lean();

  const leadIdsSet = new Set();
  verifications.forEach(v => { if (v.lead) leadIdsSet.add(String(v.lead)); });
  leads.forEach(l => { if (l._id) leadIdsSet.add(String(l._id)); });

  return {
    isSales: false,
    leadIds: Array.from(leadIdsSet).map(idStr => new mongoose.Types.ObjectId(idStr)),
    verificationIds: verifications.map(v => v._id).filter(Boolean)
  };
}

/* ─── Build mongo filter for orders ─────────────────────────────────────────── */
async function buildOrderFilter(start, end, { hub, courier, awb, state, staffId, staffScope } = {}) {
  const f = { createdAt: { $gte: start, $lte: end }, is_manual_bill: { $ne: true } };
  if (courier) f.courier_name    = { $regex: courier, $options: 'i' };
  if (awb) {
    f.awb_code = { $regex: awb, $options: 'i' };
    delete f.createdAt;
  }
  if (hub)     f.pickup_location = { $regex: hub,     $options: 'i' };
  if (state)   f.billing_state   = { $regex: state,   $options: 'i' };

  // Staff scoping: match orders via primary staff fields (task_created_by, verified_by, lead_id, verification_id, created_by)
  if (staffId) {
    const id = new mongoose.Types.ObjectId(staffId);
    if (staffScope?.isSales) {
      const orClauses = [
        { task_created_by: id, source_order_id: null },
        { created_by: id, source_order_id: null },
        { verified_by: id, source_order_id: null }
      ];
      if (staffScope?.leadIds?.length > 0) {
        orClauses.push({ lead_id: { $in: staffScope.leadIds }, source_order_id: null });
      }
      if (staffScope?.verificationIds?.length > 0) {
        orClauses.push({ verification_id: { $in: staffScope.verificationIds }, source_order_id: null });
      }
      f.$or = orClauses;
    } else {
      const orClauses = [
        { task_created_by: id },
        { verified_by: id },
        { created_by: id }
      ];
      if (staffScope?.leadIds?.length > 0) {
        orClauses.push({ lead_id: { $in: staffScope.leadIds } });
      }
      if (staffScope?.verificationIds?.length > 0) {
        orClauses.push({ verification_id: { $in: staffScope.verificationIds } });
      }
      f.$or = orClauses;
    }
  }
  return f;
}

/* ─── Status classification — covers ALL real DB values ─────────────────────── *
 * Shiprocket codes: DELIVERED, DEL, RTO_DELIVERED, RTO, RTO_INITIATED,
 *   RTO_IN_TRANSIT, RTO_INTRANSIT, RTO_NDR, RTO_OFD, RRA, OFD,
 *   OUT_FOR_DELIVERY, UND, INT, IN_TRANSIT, NEW, SC, DEX …
 * ShipMaxx codes  : DELIVERED, DEL, RTO_DELIVERED, RTO_INTRANSIT,
 *   OUT_FOR_DELIVERY, UNDELIVERED, UNDELIVERED_1ST_ATTEMPT, IN_TRANSIT …
 */
function classifyStatus(s = '') {
  const v = (s || '').trim().toUpperCase();

  // ── Delivered ──────────────────────────────────────────────────────────────
  if (v === 'DELIVERED' || v === 'DEL') return 'delivered';

  // ── RTO Intersite / In-Transit (check BEFORE generic RTO) ─────────────────
  if (
    v === 'RTO_IN_TRANSIT' || v === 'RTO_INTRANSIT' || v === 'RTO IN TRANSIT' ||
    v === 'RRA' ||                 // ShipMaxx raw code for RTO_INTRANSIT
    v === 'RTO_OFD'                // Out for delivery back to origin
  ) return 'rto_intersite';

  // ── RTO (returned / initiated / delivered back) ────────────────────────────
  if (
    v === 'RTO' || v === 'RTO_INITIATED' ||
    v === 'RTO_DELIVERED' || v === 'RTO_NDR' || v === 'RTO_UNDELIVERED' ||
    v === 'RTO_106_T'
  ) return 'rto';

  // ── Out for Delivery ───────────────────────────────────────────────────────
  if (v === 'OFD' || v === 'OUT_FOR_DELIVERY' || v === 'OUT FOR DELIVERY') return 'ofd';

  // ── Undelivered / NDR ──────────────────────────────────────────────────────
  if (
    v === 'UND' || v.includes('UNDELIVERED') || v === 'NDR' ||
    v === 'DEX' || v === 'DELIVERY_EXCEPTION' ||
    v === 'PCN'                     // Pickup cancelled / failed attempt
  ) return 'undelivered';

  // ── Canceled ───────────────────────────────────────────────────────────────
  if (v === 'CANCELED' || v === 'CANCELLED' || v === 'SHIPMENT_CANCELLED' || v === 'SC') return 'canceled';

  // ── Pickup Pending / Manifested (NEW, OUT_FOR_PICKUP, etc.) ────────────────
  if (
    v === 'NEW' || v === 'OUT_FOR_PICKUP' || v === 'PICKUP_SCHEDULED' ||
    v === 'MANIFESTED' || v === 'PICKUP_FAILED' || v === 'READY_TO_SHIP' ||
    v === 'SHIPMENT_BOOKED' || v === 'BOOKED'
  ) return 'pickup_pending';

  // ── In Transit ─────────────────────────────────────────────────────────────
  if (
    v === 'IN_TRANSIT' || v === 'INTRANSIT' || v === 'IN TRANSIT' ||
    v === 'INT' || v === 'SHIPPED' || v === 'REACHED_AT_DESTINATION_HUB' ||
    v === 'RAD' || v === '226_T'
  ) return 'in_transit';

  return 'other';
}


/* ─── Fast Batch Role Attachment ─────────────────────────────────────────────── *
 * Replaces heavy nested Mongoose populates across thousands of orders with fast
 * in-memory map lookups. Resolves user roles in 3 indexed batch queries.
 */
async function attachRolesToOrders(orders) {
  if (!orders || orders.length === 0) return orders;

  const userIds = new Set();
  const leadIds = new Set();
  const verifIds = new Set();

  for (const o of orders) {
    if (o.verified_by) userIds.add(String(o.verified_by._id || o.verified_by));
    if (o.task_created_by) userIds.add(String(o.task_created_by._id || o.task_created_by));
    if (o.created_by) userIds.add(String(o.created_by._id || o.created_by));
    if (o.lead_id) leadIds.add(String(o.lead_id._id || o.lead_id));
    if (o.verification_id) verifIds.add(String(o.verification_id._id || o.verification_id));
  }

  const [users, leads, verifications] = await Promise.all([
    userIds.size ? mongoose.model('User').find({ _id: { $in: Array.from(userIds) } }, { role: 1 }).lean() : [],
    leadIds.size ? mongoose.model('Lead').find({ _id: { $in: Array.from(leadIds) } }, { assignedTo: 1 }).lean() : [],
    verifIds.size ? mongoose.model('Verification').find({ _id: { $in: Array.from(verifIds) } }, { assignedTo: 1 }).lean() : []
  ]);

  const userMap = new Map();
  users.forEach(u => userMap.set(String(u._id), u));

  const assignedToUserIds = new Set();
  leads.forEach(l => { if (l.assignedTo) assignedToUserIds.add(String(l.assignedTo._id || l.assignedTo)); });
  verifications.forEach(v => { if (v.assignedTo) assignedToUserIds.add(String(v.assignedTo._id || v.assignedTo)); });

  if (assignedToUserIds.size > 0) {
    const assignedUsers = await mongoose.model('User').find({ _id: { $in: Array.from(assignedToUserIds) } }, { role: 1 }).lean();
    assignedUsers.forEach(u => userMap.set(String(u._id), u));
  }

  const leadMap = new Map();
  leads.forEach(l => {
    const u = l.assignedTo ? userMap.get(String(l.assignedTo._id || l.assignedTo)) : null;
    leadMap.set(String(l._id), { assignedTo: u || null });
  });

  const verifMap = new Map();
  verifications.forEach(v => {
    const u = v.assignedTo ? userMap.get(String(v.assignedTo._id || v.assignedTo)) : null;
    verifMap.set(String(v._id), { assignedTo: u || null });
  });

  for (const o of orders) {
    if (o.verified_by) o.verified_by = userMap.get(String(o.verified_by._id || o.verified_by)) || o.verified_by;
    if (o.task_created_by) o.task_created_by = userMap.get(String(o.task_created_by._id || o.task_created_by)) || o.task_created_by;
    if (o.created_by) o.created_by = userMap.get(String(o.created_by._id || o.created_by)) || o.created_by;
    if (o.lead_id) o.lead_id = leadMap.get(String(o.lead_id._id || o.lead_id)) || o.lead_id;
    if (o.verification_id) o.verification_id = verifMap.get(String(o.verification_id._id || o.verification_id)) || o.verification_id;
  }

  return orders;
}


/* ─── Fetch orders from both platforms ──────────────────────────────────────── *
 * Cohort View: Only fetch orders CREATED this period.
 * This guarantees the primary cards sum up perfectly to Total Shipments.
 * Backlog activity (orders created in previous months) are fetched separately.
 */
async function fetchOrderStats(filter) {
  const proj = { status: 1, delivery_attempt: 1, delivered_at: 1, createdAt: 1, sub_total: 1, total: 1, awb_code: 1, order_id: 1, lead_id: 1, verified_by: 1, verification_id: 1, created_by: 1, source_order_id: 1, interakt_reply_text: 1, interakt_reply_at: 1, task_created_by: 1, rto_verification_action: 1, sent_to_verification: 1 };
  const [sr, sm] = await Promise.all([
    Order.find(filter, proj).lean(),
    ShipmaxxOrder.find(filter, proj).lean(),
  ]);
  const all = [...sr, ...sm].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  
  const seen = new Set();
  const deduped = [];
  for (const o of all) {
    const key = o.awb_code ? 'awb_' + o.awb_code : (o.order_id ? 'ord_' + o.order_id : 'id_' + o._id.toString());
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(o);
    }
  }
  await attachRolesToOrders(deduped);
  return deduped;
}


function isOrderForSupport(o) {
  const isOld = Boolean(o.source_order_id);
  if (isOld) {
    // Re-order (2nd+ kit): Prioritize Support
    const candidateRoles = [
      o.verified_by?.role,
      o.verification_id?.assignedTo?.role,
      o.lead_id?.assignedTo?.role,
      o.created_by?.role,
      o.task_created_by?.role
    ].filter(Boolean);
    return candidateRoles.includes('support') || !candidateRoles.includes('sales');
  } else {
    // New order (1st kit): Prioritize Sales who generated/created/verified it
    const candidateRoles = [
      o.task_created_by?.role,
      o.created_by?.role,
      o.verified_by?.role,
      o.verification_id?.assignedTo?.role,
      o.lead_id?.assignedTo?.role
    ].filter(Boolean);
    const hasSales = candidateRoles.includes('sales');
    if (hasSales) return false;
    return candidateRoles.includes('support');
  }
}

function calcKPIs(orders, startPeriod) {
  let delivered = 0, ofd = 0, undelivered = 0, rto = 0, rtoIntersite = 0, inTransit = 0, pickupPending = 0;
  let deliveredRevenue = 0, interaktReplies = 0;
  let replyReattempt = 0, replyDawa = 0;
  let firstAttemptDelivered = 0, knownAttemptDelivered = 0, totalTat = 0, tatCount = 0;
  let salesDelivered = 0, supportDelivered = 0;
  let totalSales = 0, totalSupport = 0;

  for (const o of orders) {
    const cat = classifyStatus(o.status);
    if (cat === 'delivered' && startPeriod && o.delivered_at && new Date(o.delivered_at) < startPeriod) {
      continue;
    }

    if (o.interakt_reply_text && String(o.interakt_reply_text).trim()) {
      const replyStr = String(o.interakt_reply_text).toLowerCase();
      const isReattempt = replyStr.includes('reattempt');
      const isDawa = replyStr.includes('dawa') || replyStr.includes('medicine');
      if (isReattempt || isDawa) {
        interaktReplies++;
        if (isReattempt) replyReattempt++;
        if (isDawa) replyDawa++;
      }
    }

    const isSupportOrder = isOrderForSupport(o);

    if (isSupportOrder) totalSupport++;
    else totalSales++;

    if (cat === 'canceled') {
      continue; // Exclude canceled shipments from active status stats (In Transit, etc)
    }

    if (cat === 'delivered') {
      delivered++;
      deliveredRevenue += (Number(o.sub_total) || Number(o.total) || 0);
      
      if (isSupportOrder) supportDelivered++;
      else salesDelivered++;
      
      // Only count first-attempt for orders where delivery_attempt is explicitly set
      if (o.delivery_attempt !== null && o.delivery_attempt !== undefined) {
        knownAttemptDelivered++;
        if (o.delivery_attempt === 1) firstAttemptDelivered++;
      }
      if (o.delivered_at && o.createdAt) {
        const days = (new Date(o.delivered_at) - new Date(o.createdAt)) / 86400000;
        if (days >= 0 && days <= 60) { totalTat += days; tatCount++; }
      }
    } else if (cat === 'ofd')            { ofd++; }
    else if (cat === 'undelivered')      { undelivered++; }
    else if (cat === 'rto_intersite')    { if (o.rto_verification_action !== 'send_to_verification') rtoIntersite++; }
    else if (cat === 'rto')              { if (o.rto_verification_action !== 'send_to_verification') rto++; }
    else if (cat === 'pickup_pending')   { pickupPending++; }
    else if (cat === 'in_transit')       { inTransit++; }
  }

  const total   = totalSales + totalSupport;
  const ndrRate = total                > 0 ? +((undelivered / total)                         * 100).toFixed(1) : 0;
  const fadr    = knownAttemptDelivered > 0 ? +((firstAttemptDelivered / knownAttemptDelivered) * 100).toFixed(1) : 0;
  const avgTat  = tatCount             > 0 ? +(totalTat / tatCount).toFixed(1) : 0;
  return { delivered, ofd, undelivered, rto, rtoIntersite, inTransit, pickupPending, ndrRate, fadr, avgTat, total, deliveredRevenue, salesDelivered, supportDelivered, totalSales, totalSupport, interaktReplies, replyReattempt, replyDawa };
}

function pctChange(curr, prev) {
  if (prev === 0) return curr > 0 ? 100 : 0;
  return +(((curr - prev) / prev) * 100).toFixed(1);
}

// ─── Lead lookup cache (refreshed every 5 minutes) ─────────────────────────
let _leadCacheData = null;
let _leadCacheAt   = 0;
const LEAD_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getLeadLookup() {
  if (_leadCacheData && (Date.now() - _leadCacheAt) < LEAD_CACHE_TTL) {
    return _leadCacheData;
  }
  const { Lead } = await import('../lead/lead.model.js');
  const [allLeads, allVers] = await Promise.all([
    Lead.find({ isDeleted: { $ne: true } }).select('name phone address pincode assignedTo').lean(),
    Verification.find().select('title name phone lead assignedTo verifiedBy').populate('lead', 'name phone assignedTo').lean()
  ]);

  const byPhone = {};
  const byName  = {};
  const byPin   = {};
  const verByPhone = {};
  const verByName  = {};
  const pinCount = {};

  for (const l of allLeads) {
    if (l.phone) {
      const matches = String(l.phone).match(/\d{10}/g) || [];
      for (const m of matches) byPhone[m] = l;
      const clean = String(l.phone).replace(/\D/g, '');
      if (clean.length >= 10) byPhone[clean.slice(-10)] = l;
      byPhone[clean] = l;
    }
    if (l.name) byName[l.name.toLowerCase().trim()] = l;
    const pin = l.pincode || (l.address || '').match(/\b(\d{6})\b/)?.[1];
    if (pin) { pinCount[pin] = (pinCount[pin] || 0) + 1; byPin[pin] = l; }
  }
  for (const pin of Object.keys(pinCount)) {
    if (pinCount[pin] > 1) delete byPin[pin];
  }

  for (const v of allVers) {
    const phones = [v.lead?.phone, v.phone, v.billing_phone].filter(Boolean);
    for (const p of phones) {
      const matches = String(p).match(/\d{10}/g) || [];
      for (const m of matches) verByPhone[m] = v;
      const clean = String(p).replace(/\D/g, '');
      if (clean.length >= 10) verByPhone[clean.slice(-10)] = v;
    }
    const names = [v.lead?.name, v.title, v.customer_name].filter(Boolean);
    for (const n of names) {
      verByName[n.toLowerCase().trim()] = v;
    }
  }

  _leadCacheData = { allLeads, byPhone, byName, byPin, verByPhone, verByName };
  _leadCacheAt   = Date.now();
  return _leadCacheData;
}

async function autoLinkOrders() {
  try {
    const unlinkedSr = await Order.findOne({ $or: [{ lead_id: null }, { verified_by: null }] }).select('_id').lean();
    const unlinkedSm = await ShipmaxxOrder.findOne({ $or: [{ lead_id: null }, { verified_by: null }] }).select('_id').lean();
    if (!unlinkedSr && !unlinkedSm) return; // nothing to do

    const { byPhone, byName, byPin, verByPhone, verByName } = await getLeadLookup();

    const models = [
      { name: 'Shiprocket Order', model: Order },
      { name: 'Shipmaxx Order',   model: ShipmaxxOrder }
    ];

    // ── Step 1: match unlinked orders to leads & verifications ──────────────
    for (const { model } of models) {
      const unlinked = await model.find({ $or: [{ lead_id: null }, { verified_by: null }] })
        .select('_id billing_customer_name billing_phone billing_pincode customer_name phone customer_phone raw_response verification_id verified_by lead_id')
        .limit(150)
        .lean();
      if (unlinked.length === 0) continue;

      const bulkOps = [];
      for (const o of unlinked) {
        const phone        = o.customer_phone || o.phone || o.billing_phone || o.raw_response?.customer_phone || o.raw_response?.phone;
        const customerName = o.customer_name || o.billing_customer_name || o.raw_response?.customer_name || o.raw_response?.name;
        const pincode      = o.billing_pincode || o.raw_response?.customer_pincode || o.raw_response?.billing_zip;

        let matchedLead = null;
        let matchedVer  = null;

        if (phone) {
          const matches = String(phone).match(/\d{10}/g) || [];
          for (const m of matches) {
            if (byPhone[m]) { matchedLead = byPhone[m]; break; }
            if (verByPhone[m]) { matchedVer = verByPhone[m]; break; }
          }
          if (!matchedLead && !matchedVer) {
            const cleanPhone = String(phone).replace(/\D/g, '');
            if (cleanPhone.length >= 10) {
              matchedLead = byPhone[cleanPhone.slice(-10)];
              matchedVer  = verByPhone[cleanPhone.slice(-10)];
            }
            if (!matchedLead && !matchedVer) {
              matchedLead = byPhone[cleanPhone];
              matchedVer  = verByPhone[cleanPhone];
            }
          }
        }
        if (!matchedLead && !matchedVer && customerName) {
          const lowerName = customerName.toLowerCase().trim();
          matchedLead = byName[lowerName];
          matchedVer  = verByName[lowerName];
        }
        if (!matchedLead && !matchedVer && pincode) {
          const pin = String(pincode).trim();
          if (pin.length === 6) matchedLead = byPin[pin];
        }

        const updateSet = {};
        if (matchedVer) {
          if (!o.verification_id && matchedVer._id) updateSet.verification_id = matchedVer._id;
          if (!o.verified_by) {
            const vb = matchedVer.verifiedBy?._id || matchedVer.verifiedBy || matchedVer.assignedTo?._id || matchedVer.assignedTo;
            if (vb) updateSet.verified_by = vb;
          }
          if (!o.lead_id && (matchedVer.lead?._id || matchedVer.lead)) {
            updateSet.lead_id = matchedVer.lead._id || matchedVer.lead;
          }
        }
        if (!o.lead_id && !updateSet.lead_id && matchedLead) {
          updateSet.lead_id = matchedLead._id;
        }

        if (Object.keys(updateSet).length > 0) {
          bulkOps.push({ updateOne: { filter: { _id: o._id }, update: { $set: updateSet } } });
        }
      }
      if (bulkOps.length > 0) await model.bulkWrite(bulkOps).catch(() => {});
    }

    // ── Step 2: link staff details in BATCH ──────────────────────────────────
    for (const { model } of models) {
      const orders = await model.find({
        lead_id: { $ne: null },
        $or: [
          { verified_by:     null },
          { verification_id: null },
          { task_created_by: null }
        ]
      }).select('_id lead_id').limit(100).lean();
      if (orders.length === 0) continue;

      const leadIds = Array.from(new Set(orders.map(o => String(o.lead_id)).filter(Boolean)));
      if (leadIds.length === 0) continue;

      const [verifications, leads] = await Promise.all([
        Verification.find({ lead: { $in: leadIds } })
          .populate('task', 'createdBy')
          .sort({ createdAt: -1 })
          .lean(),
        Lead.find({ _id: { $in: leadIds } }).select('_id assignedTo').lean()
      ]);

      const verifMap = new Map();
      verifications.forEach(v => {
        if (v.lead && !verifMap.has(String(v.lead))) {
          verifMap.set(String(v.lead), v);
        }
      });

      const leadMap = new Map();
      leads.forEach(l => {
        if (l._id && !leadMap.has(String(l._id))) {
          leadMap.set(String(l._id), l);
        }
      });

      const bulkOps = [];
      for (const o of orders) {
        const verif = verifMap.get(String(o.lead_id));
        const lead  = leadMap.get(String(o.lead_id));
        const staff = verif?.verifiedBy || verif?.assignedTo || lead?.assignedTo || null;
        if (staff || verif?._id) {
          bulkOps.push({
            updateOne: {
              filter: { _id: o._id },
              update: {
                $set: {
                  verified_by:     staff,
                  verification_id: verif?._id || null,
                  task_created_by: verif?.task?.createdBy || null,
                }
              }
            }
          });
        }
      }
      if (bulkOps.length > 0) await model.bulkWrite(bulkOps).catch(() => {});
    }
  } catch (err) {
    console.error('[autoLinkOrders] error:', err.message);
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
   1. KPI Cards
══════════════════════════════════════════════════════════════════════════════ */
export async function getKPIs(params) {
  // Fire-and-forget: do NOT await so dashboard responds immediately.
  // autoLinkOrders runs in background and DB gets updated for next load.
  autoLinkOrders().catch(err => console.error('[autoLinkOrders bg]', err.message));
  const { preset, from, to, hub, courier, awb, state, staffId } = params;
  const { start, end } = buildDateRange(preset, from, to);
  const { start: ps, end: pe } = buildPrevRange(start, end);

  const staffScope = await getStaffScope(staffId);

  const f    = await buildOrderFilter(start, end, { hub, courier, awb, state, staffId, staffScope });
  const fPrv = await buildOrderFilter(ps, pe, { hub, courier, awb, state, staffId, staffScope });

  const verF    = { createdAt: { $gte: start, $lte: end } };
  const verFPrv = { createdAt: { $gte: ps,    $lte: pe  } };
  const rtsF    = { createdAt: { $gte: start, $lte: end } };
  const rtsFPrv = { createdAt: { $gte: ps,    $lte: pe  } };

  if (staffId) {
    const id = new mongoose.Types.ObjectId(staffId);
    verF.$and = [
      { createdAt: { $gte: start, $lte: end } },
      { $or: [{ verifiedBy: id }, { assignedTo: id }] }
    ];
    verFPrv.$and = [
      { createdAt: { $gte: ps, $lte: pe } },
      { $or: [{ verifiedBy: id }, { assignedTo: id }] }
    ];
    rtsF.assignedTo = id;
    rtsFPrv.assignedTo = id;
  }

  const [orders, prevOrders, verifications, prevVerifications, rtsRecords, prevRtsRecords] = await Promise.all([
    fetchOrderStats(f),
    fetchOrderStats(fPrv),
    Verification.find(verF).populate('verifiedBy', 'role').populate('assignedTo', 'role').lean(),
    Verification.find(verFPrv).populate('verifiedBy', 'role').populate('assignedTo', 'role').lean(),
    ReadyToShipment.find(rtsF).populate('assignedTo', 'role').lean(),
    ReadyToShipment.find(rtsFPrv).populate('assignedTo', 'role').lean(),
  ]);

  let verifiedSales = 0;
  let verifiedSupport = 0;
  for (const v of verifications) {
    const role = v.verifiedBy?.role || v.assignedTo?.role || '';
    if (role === 'support') verifiedSupport++;
    else verifiedSales++;
  }

  const verified = verifiedSales + verifiedSupport;

  let prevVerifiedSales = 0;
  let prevVerifiedSupport = 0;
  for (const v of prevVerifications) {
    const role = v.verifiedBy?.role || v.assignedTo?.role || '';
    if (role === 'support') prevVerifiedSupport++;
    else prevVerifiedSales++;
  }
  const prevVerified = prevVerifiedSales + prevVerifiedSupport;

  // Backlog fetches (Orders created BEFORE start, but had activity THIS period)
  const projBl = { status: 1, awb_code: 1, order_id: 1, lead_id: 1, verified_by: 1, verification_id: 1, created_by: 1, source_order_id: 1, interakt_reply_text: 1, interakt_reply_at: 1, task_created_by: 1, rto_verification_action: 1, sent_to_verification: 1 };
  const populates = [
    { path: 'lead_id', select: 'assignedTo', populate: { path: 'assignedTo', select: 'role' } },
    { path: 'verified_by', select: 'role' },
    { path: 'task_created_by', select: 'role' },
    { path: 'verification_id', select: 'assignedTo', populate: { path: 'assignedTo', select: 'role' } },
    { path: 'created_by', select: 'role' }
  ];
  const backlogFilter = { ...f, createdAt: { $lt: start } };
  
  const baseF = { ...f };
  delete baseF.createdAt;

  // Backlog delivered: orders created BEFORE start period, but delivered DURING this period.
  const backlogDeliveredFilter = {
    $and: [
      baseF,
      { createdAt: { $lt: start } },
      { status: { $in: ['DELIVERED', 'DEL'] } },
      {
        $or: [
          { delivered_at: { $gte: start, $lte: end } },
          {
            $and: [
              { status_updated_at: { $gte: start, $lte: end } },
              {
                $or: [
                  { delivered_at: null },
                  { $expr: { $eq: ["$delivered_at", "$createdAt"] } }
                ]
              }
            ]
          }
        ]
      }
    ]
  };

  // backlogActiveFilter: old orders still in transit/NDR that had activity this period
  const backlogActiveFilter = { $and: [ backlogFilter, { status: { $nin: ['DELIVERED', 'DEL'] }, status_updated_at: { $gte: start, $lte: end } } ] };

  const [blActSr, blActSm, blDelSr, blDelSm] = await Promise.all([
    Order.find(backlogActiveFilter, projBl).lean(),
    ShipmaxxOrder.find(backlogActiveFilter, projBl).lean(),
    Order.find(backlogDeliveredFilter, projBl).lean(),
    ShipmaxxOrder.find(backlogDeliveredFilter, projBl).lean(),
  ]);

  await Promise.all([
    attachRolesToOrders(blActSr),
    attachRolesToOrders(blActSm),
    attachRolesToOrders(blDelSr),
    attachRolesToOrders(blDelSm)
  ]);

  const dedup = (arr) => {
    const seen = new Set();
    const res = [];
    for (const o of arr) {
      const key = o.awb_code ? 'awb_' + o.awb_code : (o.order_id ? 'ord_' + o.order_id : 'id_' + o._id.toString());
      if (!seen.has(key)) { seen.add(key); res.push(o); }
    }
    return res;
  };

  const backlogOrders = dedup([...blActSr, ...blActSm]);
  const backlogDeliveredOrders = dedup([...blDelSr, ...blDelSm]);

  const curr = calcKPIs(orders, start);
  const prev = calcKPIs(prevOrders, ps);
  const backlog = calcKPIs(backlogOrders, start);
  const backlogDel = calcKPIs(backlogDeliveredOrders, start);

  const totalShipments = curr.total;
  const prevTotalShipments = prev.total;

  // Total delivered completed during this period (cohort + backlog delivered)
  const totalDelivered    = staffScope?.isSales
    ? (curr.salesDelivered + (backlogDel.salesDelivered || 0))
    : (curr.delivered + (backlogDel.delivered || 0));
  const totalSalesDeliv   = curr.salesDelivered + (backlogDel.salesDelivered || 0);
  const totalSupportDeliv = curr.supportDelivered + (backlogDel.supportDelivered || 0);
  const totalRevenue      = curr.deliveredRevenue + (backlogDel.deliveredRevenue || 0);

  // Delivery rate = total delivered in period / total shipments in period
  const deliveryRate = totalShipments > 0
    ? Math.min(100, Math.round((totalDelivered / totalShipments) * 100)) : 0;

  // RTO rate = rto / (total_delivered + rto + rtoIntersite)
  const rtoBase = totalDelivered + curr.rto + curr.rtoIntersite;
  const rtoRate = rtoBase > 0
    ? Math.round(((curr.rto + curr.rtoIntersite) / rtoBase) * 100) : 0;

  return {
    period: { start, end },
    kpis: {
      totalShipments:   { value: totalShipments,       change: pctChange(totalShipments,       prevTotalShipments)           },
      totalSales:       { value: curr.totalSales,      change: pctChange(curr.totalSales,      prev.totalSales)              },
      totalSupport:     { value: curr.totalSupport,    change: pctChange(curr.totalSupport,    prev.totalSupport)            },
      verified:         { value: verified,              change: pctChange(verified,             prevVerified)                 },
      verifiedSales:    { value: verifiedSales,         change: pctChange(verifiedSales,        prevVerifiedSales)            },
      verifiedSupport:  { value: verifiedSupport,       change: pctChange(verifiedSupport,      prevVerifiedSupport)          },
      pickupPending:    { value: curr.pickupPending,    change: pctChange(curr.pickupPending,   prev.pickupPending)           },
      inTransit:        { value: curr.inTransit,        change: pctChange(curr.inTransit,       prev.inTransit)               },
      ofd:              { value: curr.ofd,              change: pctChange(curr.ofd,             prev.ofd)                     },
      delivered:        { value: totalDelivered,        change: pctChange(totalDelivered,       prev.delivered)               },
      salesDelivered:   { value: totalSalesDeliv,       change: pctChange(totalSalesDeliv,      prev.salesDelivered)          },
      supportDelivered: { value: totalSupportDeliv,     change: pctChange(totalSupportDeliv,    prev.supportDelivered)        },
      // Rates
      deliveredRate:    { value: deliveryRate,          change: 0 },
      rtoRate:          { value: rtoRate,               change: 0 },
      revenue:          { value: totalRevenue,          change: 0 },
      undelivered:      { value: curr.undelivered,      change: pctChange(curr.undelivered,     prev.undelivered)             },
      rto:              { value: curr.rto,              change: pctChange(curr.rto,             prev.rto)                     },
      rtoIntersite:     { value: curr.rtoIntersite,     change: pctChange(curr.rtoIntersite,    prev.rtoIntersite)            },
      // Backlog KPIs — old orders active/delivered this period
      oldDelivered:     { value: staffScope?.isSales ? (backlogDel.salesDelivered || 0) : (backlogDel.delivered || 0), change: 0 },
      blOfd:            { value: backlog.ofd,           change: 0 },
      blUndelivered:    { value: backlog.undelivered,   change: 0 },
      blRto:            { value: backlog.rto,           change: 0 },
      blRtoIntersite:   { value: backlog.rtoIntersite,  change: 0 },
      // Performance rates
      ndrRate:          { value: curr.ndrRate,          change: pctChange(curr.ndrRate,         prev.ndrRate)                 },
      fadr:             { value: curr.fadr,             change: pctChange(curr.fadr,            prev.fadr)                    },
      avgTat:           { value: curr.avgTat,           change: pctChange(curr.avgTat,          prev.avgTat)                  },
      interaktReplies:  { value: (curr.interaktReplies || 0) + (backlog.interaktReplies || 0) + (backlogDel.interaktReplies || 0), change: 0 },
      replyReattempt:   { value: (curr.replyReattempt || 0) + (backlog.replyReattempt || 0) + (backlogDel.replyReattempt || 0), change: 0 },
      replyDawa:        { value: (curr.replyDawa || 0) + (backlog.replyDawa || 0) + (backlogDel.replyDawa || 0), change: 0 },
    },
  };
}


/* ══════════════════════════════════════════════════════════════════════════════
   2. Trend Chart
══════════════════════════════════════════════════════════════════════════════ */
export async function getTrend(params) {
  const { preset, from, to, hub, courier, state, staffId } = params;
  const { start, end } = buildDateRange(preset, from, to);
  const staffScope = await getStaffScope(staffId);
  const filter = await buildOrderFilter(start, end, { hub, courier, state, staffId, staffScope });

  const [sr, sm] = await Promise.all([
    Order.find(filter, { status: 1, createdAt: 1 }).lean(),
    ShipmaxxOrder.find(filter, { status: 1, createdAt: 1 }).lean(),
  ]);

  const byDay = {};
  for (const o of [...sr, ...sm]) {
    const key = new Date(o.createdAt).toISOString().slice(0, 10);
    if (!byDay[key]) byDay[key] = { delivered: 0, ofd: 0, undelivered: 0, rto: 0, rtoIntersite: 0 };
    const cat = classifyStatus(o.status);
    if (byDay[key][cat] !== undefined) byDay[key][cat]++;
  }

  const days = [];
  const cur = new Date(start);
  while (cur <= end) {
    const key = cur.toISOString().slice(0, 10);
    days.push({ date: key, ...(byDay[key] || { delivered: 0, ofd: 0, undelivered: 0, rto: 0, rtoIntersite: 0 }) });
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}

/* ══════════════════════════════════════════════════════════════════════════════
   3. Delivery Funnel
══════════════════════════════════════════════════════════════════════════════ */
export async function getFunnel(params) {
  const { preset, from, to, hub, courier, state, staffId } = params;
  const { start, end } = buildDateRange(preset, from, to);
  const staffScope = await getStaffScope(staffId);
  const filter = await buildOrderFilter(start, end, { hub, courier, state, staffId, staffScope });

  const verF = { createdAt: { $gte: start, $lte: end } };
  if (staffId) verF.assignedTo = new mongoose.Types.ObjectId(staffId);

  const [orders, verified] = await Promise.all([
    fetchOrderStats(filter),
    Verification.countDocuments(verF),
  ]);

  const kpis = calcKPIs(orders);
  return {
    verified,
    ofd:         kpis.ofd,
    delivered:   kpis.delivered,
    undelivered: kpis.undelivered,
    rto:         kpis.rto + kpis.rtoIntersite,
  };
}

/* ══════════════════════════════════════════════════════════════════════════════
   4. RTO Reasons
══════════════════════════════════════════════════════════════════════════════ */
export async function getRtoReasons(params) {
  const { preset, from, to, hub, courier, state, staffId } = params;
  const { start, end } = buildDateRange(preset, from, to);
  const staffScope = await getStaffScope(staffId);

  const f = { createdAt: { $gte: start, $lte: end }, rto_verification_action: { $ne: 'send_to_verification' }, is_manual_bill: { $ne: true } };
  if (hub)     f.pickup_location = { $regex: hub,     $options: 'i' };
  if (courier) f.courier_name    = { $regex: courier, $options: 'i' };
  if (state)   f.billing_state   = { $regex: state,   $options: 'i' };
  if (staffId) {
    const id = new mongoose.Types.ObjectId(staffId);
    const orClauses = [{ created_by: id }, { verified_by: id }, { 'comments.createdBy': id }];
    if (staffScope?.leadIds?.length > 0) orClauses.push({ lead_id: { $in: staffScope.leadIds } });
    if (staffScope?.verificationIds?.length > 0) orClauses.push({ verification_id: { $in: staffScope.verificationIds } });
    f.$or = orClauses;
  }

  const [srReturns, smRto] = await Promise.all([
    Return.find({ ...f, return_reason: { $exists: true, $ne: '' } }, { return_reason: 1 }).lean(),
    ShipmaxxRtoOrder.find({ ...f, problem: { $exists: true, $ne: '' } }, { problem: 1 }).lean(),
  ]);

  const normalize = (r) => {
    const v = (r || '').trim().toLowerCase();
    if (!v || v === 'n/a')                                        return 'Other';
    if (/refus|reject|cancel/i.test(v))                          return 'Customer Refused';
    if (/unreachable|no.?answer|not.?reachable|phone/i.test(v))  return 'Customer Unreachable';
    if (/address|wrong.?add|incorrect.?add|not.?found/i.test(v)) return 'Address Issue';
    if (/weather|flood|natural/i.test(v))                        return 'Weather / Natural';
    return 'Other';
  };

  const map = {};
  for (const r of srReturns) { const k = normalize(r.return_reason); map[k] = (map[k] || 0) + 1; }
  for (const r of smRto)     { const k = normalize(r.problem);        map[k] = (map[k] || 0) + 1; }
  return Object.entries(map).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
}

/* ══════════════════════════════════════════════════════════════════════════════
   5. Aging Buckets
══════════════════════════════════════════════════════════════════════════════ */
export async function getAging(params) {
  const { hub, courier, state, staffId } = params;
  const now = new Date();
  const staffScope = await getStaffScope(staffId);

  const base = { is_manual_bill: { $ne: true } };
  if (courier) base.courier_name    = { $regex: courier, $options: 'i' };
  if (hub)     base.pickup_location = { $regex: hub,     $options: 'i' };
  if (state)   base.billing_state   = { $regex: state,   $options: 'i' };
  if (staffId) {
    const id = new mongoose.Types.ObjectId(staffId);
    const orClauses = [{ created_by: id }, { verified_by: id }, { 'comments.createdBy': id }];
    if (staffScope?.leadIds?.length > 0) orClauses.push({ lead_id: { $in: staffScope.leadIds }, source_order_id: null });
    if (staffScope?.verificationIds?.length > 0) orClauses.push({ verification_id: { $in: staffScope.verificationIds }, source_order_id: null });
    base.$or = orClauses;
  }

  const proj = {
    order_id: 1, awb_code: 1, billing_customer_name: 1, billing_city: 1,
    billing_state: 1, courier_name: 1, status: 1, status_updated_at: 1,
    delivery_attempt: 1, sub_total: 1, platform: 1, rto_verification_action: 1,
    problem: 1, comments: 1, notes: 1, follow_ups: 1, order_items: 1,
    billing_phone: 1, billing_address: 1, billing_pincode: 1, verification_id: 1,
  };

  const populates = [
    { path: 'verification_id', select: 'problem department age weight height otherProblems problemDuration' },
    { path: 'comments.createdBy', select: 'name role' }
  ];

  const ofdFilter = { ...base, status: { $regex: 'out.?for.?delivery|^ofd', $options: 'i' }, status_updated_at: { $lte: new Date(now.getTime() - 2 * 86400000) } };
  const undFilter = { ...base, status: { $regex: '^undelivered|^ndr',        $options: 'i' }, delivery_attempt: { $gte: 3 } };
  const rtoFilter = { ...base, status: { $regex: 'rto.?in.?transit|rto.?intersite', $options: 'i' }, status_updated_at: { $lte: new Date(now.getTime() - 5 * 86400000) }, rto_verification_action: { $ne: 'send_to_verification' } };

  const [ofdSR, ofdSM, undSR, undSM, rtoSR, rtoSM] = await Promise.all([
    Order.find(ofdFilter, proj).populate(populates).sort({ status_updated_at: 1 }).limit(150).lean(),
    ShipmaxxOrder.find(ofdFilter, proj).populate(populates).sort({ status_updated_at: 1 }).limit(150).lean(),
    Order.find(undFilter, proj).populate(populates).sort({ delivery_attempt: -1 }).limit(150).lean(),
    ShipmaxxOrder.find(undFilter, proj).populate(populates).sort({ delivery_attempt: -1 }).limit(150).lean(),
    Order.find(rtoFilter, proj).populate(populates).sort({ status_updated_at: 1 }).limit(150).lean(),
    ShipmaxxOrder.find(rtoFilter, proj).populate(populates).sort({ status_updated_at: 1 }).limit(150).lean(),
  ]);

  const tag = (arr, plat) => arr.map(o => ({ ...o, platform: o.platform || plat }));
  return {
    ofd_stuck:           [...tag(ofdSR, 'shiprocket'), ...tag(ofdSM, 'shipmaxx')],
    undelivered_3plus:   [...tag(undSR, 'shiprocket'), ...tag(undSM, 'shipmaxx')],
    rto_intersite_stuck: [...tag(rtoSR, 'shiprocket'), ...tag(rtoSM, 'shipmaxx')],
  };
}

/* ══════════════════════════════════════════════════════════════════════════════
   6. Courier Leaderboard
══════════════════════════════════════════════════════════════════════════════ */
export async function getLeaderboard(params) {
  const { preset, from, to, hub, state, staffId } = params;
  const { start, end } = buildDateRange(preset, from, to);
  const staffScope = await getStaffScope(staffId);

  const baseMatch = {
    createdAt:    { $gte: start, $lte: end },
    courier_name: { $exists: true, $nin: [null, ''] },
  };
  if (hub)   baseMatch.pickup_location = { $regex: hub,   $options: 'i' };
  if (state) baseMatch.billing_state   = { $regex: state, $options: 'i' };
  if (staffId) {
    const id = new mongoose.Types.ObjectId(staffId);
    const orClauses = [{ created_by: id }, { verified_by: id }, { 'comments.createdBy': id }];
    if (staffScope?.leadIds?.length > 0) orClauses.push({ lead_id: { $in: staffScope.leadIds }, source_order_id: null });
    if (staffScope?.verificationIds?.length > 0) orClauses.push({ verification_id: { $in: staffScope.verificationIds }, source_order_id: null });
    baseMatch.$or = orClauses;
  }

  const [sr, sm] = await Promise.all([
    Order.find(baseMatch, { courier_name: 1, status: 1, delivered_at: 1, createdAt: 1 }).lean(),
    ShipmaxxOrder.find(baseMatch, { courier_name: 1, status: 1, delivered_at: 1, createdAt: 1 }).lean(),
  ]);

  const map = {};
  for (const o of [...sr, ...sm]) {
    const key = (o.courier_name || 'Unknown').trim();
    if (!map[key]) map[key] = { courier: key, total: 0, delivered: 0, rto: 0, undelivered: 0, totalTat: 0, tatCount: 0 };
    map[key].total++;
    const cat = classifyStatus(o.status);
    if (cat === 'delivered') {
      map[key].delivered++;
      if (o.delivered_at && o.createdAt) {
        const days = (new Date(o.delivered_at) - new Date(o.createdAt)) / 86400000;
        if (days >= 0 && days <= 60) { map[key].totalTat += days; map[key].tatCount++; }
      }
    } else if (cat === 'rto' || cat === 'rto_intersite') { map[key].rto++; }
    else if (cat === 'undelivered') { map[key].undelivered++; }
  }

  return Object.values(map)
    .map(r => ({
      courier:      r.courier,
      total:        r.total,
      delivered:    r.delivered,
      rto:          r.rto,
      undelivered:  r.undelivered,
      deliveryRate: r.total > 0 ? +((r.delivered / r.total) * 100).toFixed(1) : 0,
      rtoRate:      r.total > 0 ? +((r.rto      / r.total) * 100).toFixed(1) : 0,
      avgTat:       r.tatCount > 0 ? +(r.totalTat / r.tatCount).toFixed(1) : 0,
    }))
    .sort((a, b) => b.deliveryRate - a.deliveryRate)
    .slice(0, 30);
}

/* ══════════════════════════════════════════════════════════════════════════════
   7. Shipment List
══════════════════════════════════════════════════════════════════════════════ */
export async function getShipments(params) {
  autoLinkOrders().catch(err => console.error('[autoLinkOrders bg]', err.message));
  const { preset, from, to, hub, courier, awb, state, status, page = 1, limit = 50, platform, staffId } = params;
  const { start, end } = buildDateRange(preset, from, to);
  const staffScope = await getStaffScope(staffId);

  const baseFilter = await buildOrderFilter(start, end, { hub, courier, awb, state, staffId, staffScope });
  
  if (status && status.startsWith('bl')) {
    delete baseFilter.createdAt;
    baseFilter.createdAt = { $lt: start };
    
    let targetStatusRegex = '';
    if (status === 'blRto') targetStatusRegex = '^rto$|^rto_initiated$|^rto_delivered$|^rto_ndr$|^rto_undelivered$';
    else if (status === 'blUndelivered') targetStatusRegex = '^und$|undelivered|^ndr$|^dex$|^pcn$';
    else if (status === 'blRtoIntersite') targetStatusRegex = '^rto_in_transit$|^rto_intransit$|^rto in transit$|^rra$|^rto_ofd$';
    else if (status === 'blOfd') targetStatusRegex = '^ofd$|^out_for_delivery$|^out for delivery$';

    // If baseFilter already has an $or (for staff scoping), we must wrap everything in $and
    const baseOr = baseFilter.$or;
    delete baseFilter.$or;
    
    const andClauses = [
      { status: { $regex: targetStatusRegex, $options: 'i' } },
      { status_updated_at: { $gte: start, $lte: end } }
    ];
    if (status === 'blRto' || status === 'blRtoIntersite') {
      andClauses.push({ rto_verification_action: { $ne: 'send_to_verification' } });
    }
    if (baseOr) andClauses.push({ $or: baseOr });
    
    baseFilter.$and = andClauses;
  } else if (['interaktReplies', 'reply_reattempt', 'reply_dawa'].includes(status)) {
    delete baseFilter.createdAt;
    const ninetyDaysAgo = new Date(start.getTime() - 90 * 24 * 60 * 60 * 1000);
    baseFilter.createdAt = { $gte: ninetyDaysAgo };
    if (status === 'reply_reattempt') {
      baseFilter.interakt_reply_text = { $regex: 'reattempt', $options: 'i' };
    } else if (status === 'reply_dawa') {
      baseFilter.interakt_reply_text = { $regex: 'dawa|medicine', $options: 'i' };
    } else {
      baseFilter.interakt_reply_text = { $regex: 'reattempt|dawa|medicine', $options: 'i' };
    }
  } else if (status && status !== 'totalShipments') {
    if (['totalSales', 'totalSupport', 'salesDelivered', 'supportDelivered'].includes(status)) {
      const allCohort = await fetchOrderStats(baseFilter);
      let allOrdersToCheck = [...allCohort];

      if (['supportDelivered', 'salesDelivered'].includes(status)) {
        delete baseFilter.createdAt;
        const baseF = await buildOrderFilter(new Date(0), end, { hub, courier, awb, state, staffId, staffScope });
        const backlogDeliveredFilter = {
          $and: [
            baseF,
            { createdAt: { $lt: start } },
            { status: { $in: ['DELIVERED', 'DEL'] } },
            {
              $or: [
                { delivered_at: { $gte: start, $lte: end } },
                {
                  $and: [
                    { status_updated_at: { $gte: start, $lte: end } },
                    {
                      $or: [
                        { delivered_at: null },
                        { $expr: { $eq: ["$delivered_at", "$createdAt"] } }
                      ]
                    }
                  ]
                }
              ]
            }
          ]
        };
        const projBl = { status: 1, awb_code: 1, order_id: 1, lead_id: 1, verified_by: 1, verification_id: 1, created_by: 1, source_order_id: 1, task_created_by: 1 };
        const [blSr, blSm] = await Promise.all([
          Order.find(backlogDeliveredFilter, projBl).lean(),
          ShipmaxxOrder.find(backlogDeliveredFilter, projBl).lean()
        ]);
        await Promise.all([attachRolesToOrders(blSr), attachRolesToOrders(blSm)]);
        allOrdersToCheck.push(...blSr, ...blSm);
      }

      const targetIds = [];
      for (const o of allOrdersToCheck) {
        const isSupportOrder = isOrderForSupport(o);
        const cat = classifyStatus(o.status);

        if (cat === 'delivered' && start && o.delivered_at && new Date(o.delivered_at) < start) {
          continue;
        }

        if (status === 'totalSupport' && isSupportOrder) {
          targetIds.push(o._id);
        } else if (status === 'totalSales' && !isSupportOrder) {
          targetIds.push(o._id);
        } else if (status === 'supportDelivered' && isSupportOrder && cat === 'delivered') {
          targetIds.push(o._id);
        } else if (status === 'salesDelivered' && !isSupportOrder && cat === 'delivered') {
          targetIds.push(o._id);
        }
      }
      baseFilter._id = { $in: targetIds };
    } else if (status === 'oldDelivered') {
      baseFilter.status = { $regex: '^delivered$|^del$', $options: 'i' };
      delete baseFilter.createdAt;
      const deliveredTimeFilter = { $or: [{ delivered_at: { $gte: start, $lte: end } }, { $and: [ { status_updated_at: { $gte: start, $lte: end } }, { $or: [ { delivered_at: null }, { $expr: { $eq: ["$delivered_at", "$createdAt"] } } ] } ] }] };
      baseFilter.$and = baseFilter.$and || [];
      baseFilter.$and.push(
        { createdAt: { $lt: start } },
        deliveredTimeFilter
      );
    } else {
      const statusRegex = { 
        pickupPending: '^new$|^out_for_pickup$|^pickup_scheduled$|^manifested$|^pickup_failed$|^ready_to_ship$|^shipment_booked$|^booked$',
        inTransit: '^in_transit$|^intransit$|^in transit$|^int$|^shipped$|^reached_at_destination_hub$|^rad$|^226_t$',
        delivered: '^delivered$|^del$', 
        ofd: '^ofd$|^out_for_delivery$|^out for delivery$', 
        undelivered: '^und$|undelivered|^ndr$|^dex$|^pcn$|^delivery_exception$|^lost$', 
        rto: '^rto$|^rto_initiated$|^rto_delivered$|^rto_ndr$|^rto_undelivered$|^rto_106_t$',
        rtoIntersite: '^rto_in_transit$|^rto_intransit$|^rto in transit$|^rra$|^rto_ofd$'
      };
      
      baseFilter.status = { $regex: statusRegex[status] || status, $options: 'i' };

      if (status === 'rto' || status === 'rtoIntersite') {
        baseFilter.rto_verification_action = { $ne: 'send_to_verification' };
      }

      if (status === 'delivered') {
        delete baseFilter.createdAt;
        const deliveredTimeFilter = { $or: [{ delivered_at: { $gte: start, $lte: end } }, { $and: [ { status_updated_at: { $gte: start, $lte: end } }, { $or: [ { delivered_at: null }, { $expr: { $eq: ["$delivered_at", "$createdAt"] } } ] } ] }] };
        const cohortDeliveredFilter = { 
          $and: [
            { createdAt: { $gte: start, $lte: end } },
            {
              $or: [
                { delivered_at: { $gte: start } },
                { delivered_at: { $exists: false } },
                { delivered_at: null }
              ]
            }
          ]
        };
        baseFilter.$and = baseFilter.$and || [];
        baseFilter.$and.push({
          $or: [
            cohortDeliveredFilter,
            { $and: [ { createdAt: { $lt: start } }, deliveredTimeFilter ] }
          ]
        });
      }
    }
  }

  const skip = (Number(page) - 1) * Number(limit);
  const proj = {
    order_id: 1, awb_code: 1, billing_customer_name: 1, billing_phone: 1,
    billing_city: 1, billing_state: 1, courier_name: 1, status: 1,
    status_updated_at: 1, delivery_attempt: 1, sub_total: 1, payment_method: 1,
    delivered_at: 1, createdAt: 1, platform: 1, pickup_location: 1, lead_id: 1,
    rto_verification_action: 1, problem: 1, comments: 1, notes: 1, follow_ups: 1,
    order_items: 1, billing_address: 1, billing_pincode: 1, verification_id: 1,
    interakt_reply_text: 1, interakt_reply_at: 1,
  };

  const populates = [
    { path: 'verification_id', select: 'problem department age weight height otherProblems problemDuration' },
    { path: 'comments.createdBy', select: 'name role' }
  ];

  let srOrders = [], smOrders = [], verOrders = [], srTotal = 0, smTotal = 0, verTotal = 0;
  
  if (['verified', 'verifiedSales', 'verifiedSupport'].includes(status)) {
    const verF = { createdAt: { $gte: start, $lte: end } };
    if (staffId) verF.assignedTo = new mongoose.Types.ObjectId(staffId);

    const User = (await import('../user/user.model.js')).default;
    const salesUsers = await User.find({ role: 'sales' }, '_id').lean();
    const supportUsers = await User.find({ role: 'support' }, '_id').lean();
    const salesUserIds = salesUsers.map(u => u._id);
    const supportUserIds = supportUsers.map(u => u._id);

    if (status === 'verifiedSales') {
      verF.$and = [
        { verifiedBy: { $nin: supportUserIds } },
        { assignedTo: { $nin: supportUserIds } }
      ];
    } else if (status === 'verifiedSupport') {
      verF.$or = [
        { verifiedBy: { $in: supportUserIds } },
        { assignedTo: { $in: supportUserIds } }
      ];
    }
    
    const [total, records] = await Promise.all([
      Verification.countDocuments(verF),
      Verification.find(verF)
        .populate('lead', 'name phone price amount')
        .populate('verifiedBy', 'name role')
        .populate('assignedTo', 'name role')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean()
    ]);
    verTotal = total;
    verOrders = records.map(v => ({
      _id: v._id,
      platform: 'verification',
      status: v.status || 'verified',
      billing_customer_name: v.lead?.name || v.title || 'Unknown',
      billing_phone: v.lead?.phone || '',
      billing_city: v.cityVillage || '',
      billing_state: v.state || '',
      sub_total: Number(v.price || v.lead?.price || v.lead?.amount || 0),
      createdAt: v.createdAt,
      awb_code: '',
      courier_name: v.verifiedBy?.name ? `Verifier: ${v.verifiedBy.name}` : (v.assignedTo?.name ? `Staff: ${v.assignedTo.name}` : '—'),
      delivery_attempt: 0
    }));
  }

  let combined = [];
  if (['verified', 'verifiedSales', 'verifiedSupport'].includes(status)) {
    combined = verOrders;
  } else {
    const sortField = ['interaktReplies', 'reply_reattempt', 'reply_dawa'].includes(status) ? 'interakt_reply_at' : ((status && status !== 'totalShipments') ? 'status_updated_at' : 'createdAt');
    let srOrders = [];
    let smOrders = [];
    const fetchLimit = skip + Number(limit);

    if (!platform || platform === 'shiprocket') {
      const [records, count] = await Promise.all([
        Order.find(baseFilter, proj).populate(populates).sort({ [sortField]: -1 }).limit(fetchLimit).lean(),
        Order.countDocuments(baseFilter)
      ]);
      srOrders = records;
      srTotal = count;
    }
    if (!platform || platform === 'shipmaxx') {
      const [records, count] = await Promise.all([
        ShipmaxxOrder.find(baseFilter, proj).populate(populates).sort({ [sortField]: -1 }).limit(fetchLimit).lean(),
        ShipmaxxOrder.countDocuments(baseFilter)
      ]);
      smOrders = records;
      smTotal = count;
    }

    const all = [
      ...srOrders.map(o => ({ ...o, platform: 'shiprocket' })),
      ...smOrders.map(o => ({ ...o, platform: 'shipmaxx' })),
    ].sort((a, b) => {
      const dateA = a[sortField] ? new Date(a[sortField]) : new Date(0);
      const dateB = b[sortField] ? new Date(b[sortField]) : new Date(0);
      return dateB - dateA;
    });

    const seen = new Set();
    const deduped = [];
    for (const o of all) {
      const key = o.awb_code ? 'awb_' + o.awb_code : (o.order_id ? 'ord_' + o.order_id : 'id_' + o._id.toString());
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(o);
      }
    }

    combined = deduped.slice(skip, skip + Number(limit));
  }

  const totalAll = verTotal > 0 ? verTotal : (srTotal + smTotal);

  return { total: totalAll, page: Number(page), limit: Number(limit), pages: Math.ceil(totalAll / Number(limit)), shipments: combined };
}

/* ══════════════════════════════════════════════════════════════════════════════
   8. Alerts (always company-wide)
══════════════════════════════════════════════════════════════════════════════ */
const SLA_DAYS = 5;

export async function getAlerts(params) {
  const { rtoThreshold = 8, ndrThreshold = 15, preset, from, to } = params;
  const { start, end } = buildDateRange(preset, from, to);
  const orders = await fetchOrderStats({ createdAt: { $gte: start, $lte: end } });
  const kpis   = calcKPIs(orders);
  const alerts  = [];

  if (kpis.ndrRate > Number(ndrThreshold)) alerts.push({ type: 'ndr_rate', severity: 'high', message: `NDR rate is ${kpis.ndrRate}% — above threshold of ${ndrThreshold}%`, value: kpis.ndrRate });
  const rtoRate = kpis.total > 0 ? +(((kpis.rto + kpis.rtoIntersite) / kpis.total) * 100).toFixed(1) : 0;
  if (rtoRate > Number(rtoThreshold))      alerts.push({ type: 'rto_rate', severity: 'high', message: `RTO rate is ${rtoRate}% — above threshold of ${rtoThreshold}%`, value: rtoRate });

  const slaCutoff = new Date(Date.now() - SLA_DAYS * 86400000);
  const slaF = { createdAt: { $lte: slaCutoff }, delivered_at: { $exists: false }, status: { $not: { $regex: '^delivered$', $options: 'i' } } };
  const [srSla, smSla] = await Promise.all([Order.countDocuments(slaF), ShipmaxxOrder.countDocuments(slaF)]);
  const slaBreach = srSla + smSla;
  if (slaBreach > 0) alerts.push({ type: 'sla_breach', severity: slaBreach > 50 ? 'critical' : 'medium', message: `${slaBreach} shipment${slaBreach > 1 ? 's' : ''} exceeded the ${SLA_DAYS}-day SLA`, value: slaBreach });

  return { alerts, kpis: { ndrRate: kpis.ndrRate, rtoRate, slaBreach } };
}

/* ══════════════════════════════════════════════════════════════════════════════
   9. RTO Verification & Order Comments
══════════════════════════════════════════════════════════════════════════════ */
export async function submitRtoVerification({ order_id, platform, action, comment, userId }) {
  if (!order_id) {
    throw new Error('Order ID is required');
  }
  
  const update = {};
  if (action) {
    update.$set = { rto_verification_action: action };
    if (action === 'send_to_verification') {
      update.$set.sent_to_verification = true;
      update.$set.sent_to_verification_at = new Date();
      if (userId) update.$set.sent_to_verification_by = userId;
    }
  }
  if (comment && String(comment).trim()) {
    update.$push = {
      comments: {
        text: String(comment).trim(),
        type: 'general',
        section: 'rto_verification',
        createdBy: userId || null,
        createdAt: new Date(),
      }
    };
  }

  if (!update.$set && !update.$push) {
    throw new Error('Action or comment is required');
  }

  const queryOr = [{ order_id }, { awb_code: order_id }];
  if (mongoose.Types.ObjectId.isValid(order_id)) {
    queryOr.push({ _id: order_id });
  }

  const PrimaryModel = platform === 'shipmaxx' ? ShipmaxxOrder : Order;
  const SecondaryModel = platform === 'shipmaxx' ? Order : ShipmaxxOrder;

  let order = await PrimaryModel.findOneAndUpdate({ $or: queryOr }, update, { new: true })
    .populate('comments.createdBy', 'name role')
    .lean();

  if (!order) {
    order = await SecondaryModel.findOneAndUpdate({ $or: queryOr }, update, { new: true })
      .populate('comments.createdBy', 'name role')
      .lean();
  }

  if (!order) throw new Error('Shipment order not found');
  import('../dashboard/dashboard.controller.js').then(m => m.clearDashboardCache && m.clearDashboardCache()).catch(() => {});
  return order;
}

/* ══════════════════════════════════════════════════════════════════════════════
   10. Interakt Template Message Sending (Data-Wise for Undelivered / Shipments)
══════════════════════════════════════════════════════════════════════════════ */
export async function sendInteraktTemplateMessages({ items = [], filterParams = null, templateName, languageCode }) {
  const tmplName = templateName || process.env.INTERAKT_UNDELIVERED_TEMPLATE || process.env.INTERAKT_BULK_TEMPLATE_UNDELIVERED || 'undeliveredattempt_ts';
  const tmplLang = languageCode || 'en';
  
  let targetShipments = items;
  if (!targetShipments || !targetShipments.length) {
    if (filterParams) {
      const res = await getShipments({ ...filterParams, page: 1, limit: 1000 });
      targetShipments = res.shipments || [];
    }
  }

  if (!targetShipments || !targetShipments.length) {
    return { status: 'completed', total: 0, sent_count: 0, failed_count: 0, excluded_count: 0, message: 'No matching shipments found to message' };
  }

  let sent_count = 0;
  let failed_count = 0;
  let excluded_count = 0;
  const errors = [];

  for (const item of targetShipments) {
    const phone = item.billing_phone || item.phone;
    if (!phone || String(phone).replace(/\D/g, '').length < 10) {
      excluded_count++;
      continue;
    }
    const customerName = item.billing_customer_name || item.customerName || 'Customer';
    const awbCode = item.awb_code || item.awbCode || 'Order';
    const courierName = item.courier_name || item.courierName || 'Delivery Partner';
    const amount = item.sub_total || item.amount || 0;
    const status = item.status || 'Undelivered';

    // The standard Interakt utility templates for this org (undeliveredattempt, crm_bulk_*) expect exactly 1 body variable ({{1}} = Customer Name).
    // Passing extra body values causes a 400 Bad Request from Interakt.
    const isSingleVarTemplate = tmplName.includes('undeliveredattempt') || tmplName.startsWith('crm_bulk_') || tmplName === 'hello_world';
    const bodyValues = isSingleVarTemplate ? [
      String(customerName)
    ] : [
      String(customerName),
      String(awbCode),
      String(courierName),
      String(amount ? `₹${amount}` : '₹0'),
      String(status)
    ];

    let success = false;
    let primaryErrMsg = '';
    let lastErrMsg = '';
    
    // Test primary language first, then fallback across other standard Interakt WhatsApp language variants
    const langVariants = Array.from(new Set([tmplLang, 'en', 'en_US', 'en_GB']));
    
    for (const testLang of langVariants) {
      try {
        await sendWhatsAppMessage({
          phone: String(phone),
          messageText: `Dear ${customerName}, update regarding your shipment ${awbCode} via ${courierName}.`,
          bodyValues,
          templateName: tmplName,
          languageCode: testLang,
        });
        success = true;
        break;
      } catch (err) {
        lastErrMsg = err?.response?.data?.message || err?.message || 'Unknown error';
        if (!primaryErrMsg) primaryErrMsg = lastErrMsg;
        // If error is not a template language error, do not retry other languages
        if (!lastErrMsg.toLowerCase().includes('no approved template found')) {
          break;
        }
      }
    }

    if (success) {
      sent_count++;
    } else {
      failed_count++;
      if (errors.length < 5) errors.push(`${phone}: ${primaryErrMsg || lastErrMsg}`);
    }
  }

  return {
    status: 'completed',
    total: targetShipments.length,
    sent_count,
    failed_count,
    excluded_count,
    errors,
    message: `Processed ${targetShipments.length} shipments: ${sent_count} sent, ${failed_count} failed, ${excluded_count} excluded.`
  };
}

export async function createInvoiceHistory(data, userId) {
  return await InvoiceHistory.findOneAndUpdate(
    { billNumber: data.billNumber },
    { ...data, generatedBy: userId },
    { upsert: true, new: true, runValidators: true }
  );
}

export async function getInvoiceHistory(params) {
  const query = {};
  if (params.orderId) query.orderId = params.orderId;
  if (params.billNumber) query.billNumber = params.billNumber;
  
  const page = Math.max(1, parseInt(params.page) || 1);
  const limit = Math.max(1, parseInt(params.limit) || 50);
  const skip = (page - 1) * limit;

  const total = await InvoiceHistory.countDocuments(query);
  const invoices = await InvoiceHistory.find(query)
    .populate('generatedBy', 'name email role')
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean();

  return {
    invoices,
    total,
    page,
    pages: Math.ceil(total / limit)
  };
}

export async function getStaffBreakdown(params = {}) {
  const { preset, from, to } = params;
  const User = mongoose.model('User');
  const salesStaff = await User.find({ role: 'sales', isDeleted: false }).select('_id name role').sort({ name: 1 }).lean();
  const supportStaff = await User.find({ role: 'support', isDeleted: false }).select('_id name role').sort({ name: 1 }).lean();

  const { getAllStaffStats } = await import('../dashboard/dashboard.service.js');
  const targetDate = (from && from !== 'undefined') ? from : new Date().toISOString().split('T')[0];
  const crmRes = await getAllStaffStats(targetDate, from, to, preset || 'today');
  const crmStatsList = crmRes?.staffStats || [];
  const crmMap = {};
  crmStatsList.forEach(item => {
    if (item.user?._id) {
      crmMap[String(item.user._id)] = item;
    }
  });

  const allStaff = [...salesStaff, ...supportStaff];
  const staffResults = await Promise.all(
    allStaff.map(async (u) => {
      const uId = String(u._id);
      const res = await getKPIs({ preset: preset || 'month', from, to, staffId: uId });
      const k = res.kpis || {};
      const rtoNdr = (k.undelivered?.value || 0) + (k.rto?.value || 0) + (k.rtoIntersite?.value || 0);

      const crmItem = crmMap[uId] || {};
      return {
        id: uId,
        name: u.name,
        role: u.role,
        // CRM breakdown fields
        leads: crmItem.leadsAdded || 0,
        tasks: crmItem.tasksAssigned || 0,
        pendingTasks: crmItem.pendingTasks || 0,
        afterCheckoutLeads: crmItem.afterCheckoutLeads || 0,
        afterCheckoutTasks: crmItem.afterCheckoutTasks || 0,
        cnp: crmItem.todayCnp || 0,
        callAgain: crmItem.todayCallAgain || 0,
        notInterested: crmItem.todayNotInterested || 0,
        verified: Math.max(crmItem.todayVerifications || 0, crmItem.verifiedCount || 0, k.verified?.value || 0),
        // Shipment breakdown fields
        totalShipments: k.totalShipments?.value || 0,
        delivered: k.delivered?.value || 0,
        inTransit: k.inTransit?.value || 0,
        ofd: k.ofd?.value || 0,
        rtoNdr: rtoNdr
      };
    })
  );

  return {
    sales: staffResults.filter(s => s.role === 'sales'),
    support: staffResults.filter(s => s.role === 'support')
  };
}



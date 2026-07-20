import mongoose from 'mongoose';
import { Order } from '../shiprocket/models/order.model.js';
import { ShipmaxxOrder } from '../shipmaxx/models/shipmaxxOrder.model.js';
import { Return } from '../shiprocket/models/return.model.js';
import { ShipmaxxRtoOrder } from '../shipmaxx/models/shipmaxxRtoOrder.model.js';
import Verification from '../verification/verification.model.js';
import { NdrNote } from '../shiprocket/models/ndrNote.model.js';

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
  if (preset === 'last7' || preset === 'weekly') return { start: new Date(now.getTime() - 7 * 86400000), end: now };
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
  const verifications = await mongoose.model('Verification').find({ $or: [{ verifiedBy: id }, { assignedTo: id }] }, { lead: 1, _id: 1 }).lean();
  return {
    leadIds: verifications.map(v => v.lead).filter(Boolean),
    verificationIds: verifications.map(v => v._id).filter(Boolean)
  };
}

/* ─── Build mongo filter for orders ─────────────────────────────────────────── */
async function buildOrderFilter(start, end, { hub, courier, awb, state, staffId, staffScope } = {}) {
  const f = { createdAt: { $gte: start, $lte: end } };
  if (courier) f.courier_name    = { $regex: courier, $options: 'i' };
  if (awb)     f.awb_code        = { $regex: awb,     $options: 'i' };
  if (hub)     f.pickup_location = { $regex: hub,     $options: 'i' };
  if (state)   f.billing_state   = { $regex: state,   $options: 'i' };

  // Staff scoping: match orders via lead_id (primary), or created_by / verified_by (fallback)
  if (staffId) {
    const id = new mongoose.Types.ObjectId(staffId);
    
    // Find AWBs for any NDR notes created by this user
    const ndrNotes = await mongoose.model('NdrNote').find({ createdBy: id }).select('awb_number').lean();
    const ndrAwbs = ndrNotes.map(n => n.awb_number).filter(Boolean);

    // Find Orders for any Followups assigned to this user
    const [srF, smF] = await Promise.all([
      mongoose.model('Followup').find({ staff: id }).select('order_id').lean(),
      mongoose.model('ShipmaxxFollowup').find({ staff: id }).select('order_id').lean()
    ]);
    const followupOrderIds = [...srF.map(f => f.order_id), ...smF.map(f => f.order_id)].filter(Boolean);

    const orClauses = [
      { created_by: id },
      { verified_by: id }, // Support's re-orders have verified_by: supportId, and we need them to count!
      { 'comments.createdBy': id }
    ];
    
    if (staffScope?.leadIds?.length > 0) {
      orClauses.push({ lead_id: { $in: staffScope.leadIds }, source_order_id: null });
    }
    if (staffScope?.verificationIds?.length > 0) {
      orClauses.push({ verification_id: { $in: staffScope.verificationIds }, source_order_id: null });
    }
    if (ndrAwbs.length > 0) {
      orClauses.push({ awb_code: { $in: ndrAwbs } });
    }
    if (followupOrderIds.length > 0) {
      orClauses.push({ _id: { $in: followupOrderIds } });
      orClauses.push({ order_id: { $in: followupOrderIds.map(String) } }); // For ShipmaxxOrder string order_id
    }
    f.$or = orClauses;
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
    v === 'RTO_DELIVERED' || v === 'RTO_NDR' || v === 'RTO_UNDELIVERED'
  ) return 'rto';

  // ── Out for Delivery ───────────────────────────────────────────────────────
  if (v === 'OFD' || v === 'OUT_FOR_DELIVERY' || v === 'OUT FOR DELIVERY') return 'ofd';

  // ── Undelivered / NDR ──────────────────────────────────────────────────────
  if (
    v === 'UND' || v.includes('UNDELIVERED') || v === 'NDR' ||
    v === 'DEX' ||                  // Delivery exception
    v === 'PCN'                     // Pickup cancelled / failed attempt
  ) return 'undelivered';

  return 'other';
}


/* ─── Fetch orders from both platforms ──────────────────────────────────────── *
 * Cohort View: Only fetch orders CREATED this period.
 * This guarantees the primary cards sum up perfectly to Total Shipments.
 * Backlog activity (orders created in previous months) are fetched separately.
 */
async function fetchOrderStats(filter) {
  const proj = { status: 1, delivery_attempt: 1, delivered_at: 1, createdAt: 1, sub_total: 1, total: 1, awb_code: 1, order_id: 1, lead_id: 1, verified_by: 1, verification_id: 1, created_by: 1, source_order_id: 1 };
  const populates = [
    { path: 'lead_id', select: 'assignedTo', populate: { path: 'assignedTo', select: 'role' } },
    { path: 'verified_by', select: 'role' },
    { path: 'verification_id', select: 'assignedTo', populate: { path: 'assignedTo', select: 'role' } },
    { path: 'created_by', select: 'role' }
  ];
  const [sr, sm] = await Promise.all([
    Order.find(filter, proj).populate(populates).lean(),
    ShipmaxxOrder.find(filter, proj).populate(populates).lean(),
  ]);
  const all = [...sr, ...sm].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  
  const seen = new Set();
  const deduped = [];
  for (const o of all) {
    const leadKey = o.lead_id ? (o.lead_id._id ? o.lead_id._id.toString() : o.lead_id.toString()) : null;
    const key = leadKey ? 'lead_' + leadKey : (o.awb_code ? 'awb_' + o.awb_code : (o.order_id ? 'ord_' + o.order_id : 'id_' + o._id.toString()));
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(o);
    }
  }
  return deduped;
}


function calcKPIs(orders) {
  let delivered = 0, ofd = 0, undelivered = 0, rto = 0, rtoIntersite = 0, inTransit = 0, deliveredRevenue = 0;
  let firstAttemptDelivered = 0, knownAttemptDelivered = 0, totalTat = 0, tatCount = 0;
  let salesDelivered = 0, supportDelivered = 0;
  let totalSales = 0, totalSupport = 0;

  for (const o of orders) {
    let staffRole = '';
    // If it's a fresh sale (source_order_id is null), prioritize Lead Owner (Sales)
    // If it's a re-order (source_order_id exists), prioritize the person who verified it (Support)
    if (o.source_order_id) {
      staffRole = o.verified_by?.role || o.verification_id?.assignedTo?.role || o.created_by?.role || o.lead_id?.assignedTo?.role || '';
    } else {
      staffRole = o.lead_id?.assignedTo?.role || o.verified_by?.role || o.verification_id?.assignedTo?.role || o.created_by?.role || '';
    }
    
    if (staffRole === 'sales') totalSales++;
    else totalSupport++;

    const cat = classifyStatus(o.status);
    if (cat === 'delivered') {
      delivered++;
      deliveredRevenue += (Number(o.sub_total) || Number(o.total) || 0);
      
      if (staffRole === 'sales') salesDelivered++;
      else supportDelivered++;
      
      // Only count first-attempt for orders where delivery_attempt is explicitly set
      if (o.delivery_attempt !== null && o.delivery_attempt !== undefined) {
        knownAttemptDelivered++;
        if (o.delivery_attempt === 1) firstAttemptDelivered++;
      }
      if (o.delivered_at && o.createdAt) {
        const days = (new Date(o.delivered_at) - new Date(o.createdAt)) / 86400000;
        if (days >= 0 && days <= 60) { totalTat += days; tatCount++; }
      }
    } else if (cat === 'ofd')         { ofd++; }
    else if (cat === 'undelivered')   { undelivered++; }
    else if (cat === 'rto_intersite') { rtoIntersite++; }
    else if (cat === 'rto')           { rto++; }
    else                              { inTransit++; }
  }

  const total   = delivered + ofd + undelivered + rto + rtoIntersite + inTransit;
  const ndrRate = total                > 0 ? +((undelivered / total)                         * 100).toFixed(1) : 0;
  const fadr    = knownAttemptDelivered > 0 ? +((firstAttemptDelivered / knownAttemptDelivered) * 100).toFixed(1) : 0;
  const avgTat  = tatCount             > 0 ? +(totalTat / tatCount).toFixed(1) : 0;
  return { delivered, ofd, undelivered, rto, rtoIntersite, inTransit, ndrRate, fadr, avgTat, total, deliveredRevenue, salesDelivered, supportDelivered, totalSales, totalSupport };
}

function pctChange(curr, prev) {
  if (prev === 0) return curr > 0 ? 100 : 0;
  return +(((curr - prev) / prev) * 100).toFixed(1);
}

/* ══════════════════════════════════════════════════════════════════════════════
   1. KPI Cards
══════════════════════════════════════════════════════════════════════════════ */
export async function getKPIs(params) {
  const { preset, from, to, hub, courier, awb, state, staffId } = params;
  const { start, end } = buildDateRange(preset, from, to);
  const { start: ps, end: pe } = buildPrevRange(start, end);

  const staffScope = await getStaffScope(staffId);

  const f    = await buildOrderFilter(start, end, { hub, courier, awb, state, staffId, staffScope });
  const fPrv = await buildOrderFilter(ps, pe, { hub, courier, awb, state, staffId, staffScope });

  const verF    = { createdAt: { $gte: start, $lte: end } };
  const verFPrv = { createdAt: { $gte: ps,    $lte: pe  } };
  if (staffId) {
    const id = new mongoose.Types.ObjectId(staffId);
    verF.$or    = [{ verifiedBy: id }, { assignedTo: id }];
    verFPrv.$or = [{ verifiedBy: id }, { assignedTo: id }];
  }

  const [orders, prevOrders, verified, prevVerified] = await Promise.all([
    fetchOrderStats(f),
    fetchOrderStats(fPrv),
    Verification.countDocuments(verF),
    Verification.countDocuments(verFPrv)
  ]);

  // Backlog fetches (Orders created BEFORE start, but had activity THIS period)
  const projBl = { status: 1, awb_code: 1, order_id: 1, lead_id: 1, verified_by: 1, verification_id: 1, created_by: 1, source_order_id: 1 };
  const populates = [
    { path: 'lead_id', select: 'assignedTo', populate: { path: 'assignedTo', select: 'role' } },
    { path: 'verified_by', select: 'role' },
    { path: 'verification_id', select: 'assignedTo', populate: { path: 'assignedTo', select: 'role' } },
    { path: 'created_by', select: 'role' }
  ];
  const backlogFilter = { ...f, createdAt: { $lt: start } };
  
  const baseF = { ...f };
  delete baseF.createdAt;

  // For total delivered, check either delivered_at OR status_updated_at (fallback if delivered_at is missing)
  const deliveredTimeFilter = { $or: [ { delivered_at: { $gte: start, $lte: end } }, { delivered_at: { $exists: false }, status_updated_at: { $gte: start, $lte: end } }, { delivered_at: null, status_updated_at: { $gte: start, $lte: end } } ] };
  
  const backlogActiveFilter = { $and: [ backlogFilter, { status: { $nin: ['DELIVERED', 'DEL'] }, status_updated_at: { $gte: start, $lte: end } } ] };
  const backlogDeliveredFilter = { $and: [ baseF, { createdAt: { $lt: start }, status: { $in: ['DELIVERED', 'DEL'] } }, deliveredTimeFilter ] };

  const [blActSr, blActSm, blDelSr, blDelSm] = await Promise.all([
    Order.find(backlogActiveFilter, projBl).populate(populates).lean(),
    ShipmaxxOrder.find(backlogActiveFilter, projBl).populate(populates).lean(),
    Order.find(backlogDeliveredFilter, projBl).populate(populates).lean(),
    ShipmaxxOrder.find(backlogDeliveredFilter, projBl).populate(populates).lean()
  ]);

  // Live RTO Intersite query (ignores date range entirely to show all active)
  const rtoIntersiteFilter = { ...baseF };
  rtoIntersiteFilter.status = { $regex: '^rto_in_transit$|^rto_intransit$|^rto in transit$|^rra$|^rto_ofd$', $options: 'i' };
  const [liveRtoIntersiteSr, liveRtoIntersiteSm] = await Promise.all([
    Order.countDocuments(rtoIntersiteFilter),
    ShipmaxxOrder.countDocuments(rtoIntersiteFilter)
  ]);
  const liveRtoIntersiteCount = liveRtoIntersiteSr + liveRtoIntersiteSm;

  const dedup = (arr) => {
    const seen = new Set();
    const res = [];
    for (const o of arr) {
      const leadKey = o.lead_id ? (o.lead_id._id ? o.lead_id._id.toString() : o.lead_id.toString()) : null;
      const key = leadKey ? 'lead_' + leadKey : (o.awb_code ? 'awb_' + o.awb_code : (o.order_id ? 'ord_' + o.order_id : 'id_' + o._id.toString()));
      if (!seen.has(key)) { seen.add(key); res.push(o); }
    }
    return res;
  };

  const backlogOrders = dedup([...blActSr, ...blActSm]);
  const backlogDeliveredOrders = dedup([...blDelSr, ...blDelSm]);

  const curr = calcKPIs(orders);
  const prev = calcKPIs(prevOrders);
  const backlog = calcKPIs(backlogOrders);
  const backlogDel = calcKPIs(backlogDeliveredOrders);

  const totalShipments = curr.total;
  const prevTotalShipments = prev.total;

  // Directly calculate old deliveries instead of (Total - New) to avoid undercounting issues
  const calculatedBlDelivered = backlogDeliveredOrders.length;

  return {
    period: { start, end },
    kpis: {
      totalShipments: { value: totalShipments,    change: pctChange(totalShipments,    prevTotalShipments) },
      totalSales:     { value: curr.totalSales,   change: pctChange(curr.totalSales,   prev.totalSales) },
      totalSupport:   { value: curr.totalSupport, change: pctChange(curr.totalSupport, prev.totalSupport) },
      verified:       { value: verified,           change: pctChange(verified,          prevVerified)       },
      inTransit:      { value: curr.inTransit,     change: pctChange(curr.inTransit,    prev.inTransit)     },
      ofd:            { value: curr.ofd,           change: pctChange(curr.ofd,          prev.ofd)           },
      delivered:      { value: curr.delivered + calculatedBlDelivered,     change: pctChange(curr.delivered + calculatedBlDelivered,    prev.delivered)     },
      salesDelivered: { value: curr.salesDelivered, change: pctChange(curr.salesDelivered, prev.salesDelivered) },
      supportDelivered: { value: curr.supportDelivered + calculatedBlDelivered, change: pctChange(curr.supportDelivered + calculatedBlDelivered, prev.supportDelivered) },
      deliveredRate:  { value: totalShipments ? Math.round((curr.delivered / totalShipments) * 100) : 0, change: 0 },
      rtoRate:        { value: (curr.delivered + curr.rto + curr.rtoIntersite) > 0 ? Math.round(((curr.rto + curr.rtoIntersite) / (curr.delivered + curr.rto + curr.rtoIntersite)) * 100) : 0, change: 0 },
      revenue:        { value: curr.deliveredRevenue, change: 0 },
      undelivered:    { value: curr.undelivered,   change: pctChange(curr.undelivered,  prev.undelivered)   },
      rto:            { value: curr.rto,           change: pctChange(curr.rto,          prev.rto)           },
      rtoIntersite:   { value: liveRtoIntersiteCount, change: pctChange(liveRtoIntersiteCount, prev.rtoIntersite) },
      // Backlog KPIs (kept for legacy support if frontend still asks for it)
      blDelivered:    { value: calculatedBlDelivered, change: 0 },
      blOfd:          { value: backlog.ofd,           change: 0 },
      blUndelivered:  { value: backlog.undelivered,   change: 0 },
      blRto:          { value: backlog.rto,           change: 0 },
      blRtoIntersite: { value: backlog.rtoIntersite,  change: 0 },
      // Rates
      ndrRate:        { value: curr.ndrRate,       change: pctChange(curr.ndrRate,      prev.ndrRate)       },
      fadr:           { value: curr.fadr,          change: pctChange(curr.fadr,         prev.fadr)          },
      avgTat:         { value: curr.avgTat,        change: pctChange(curr.avgTat,       prev.avgTat)        },
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

  const f = { createdAt: { $gte: start, $lte: end } };
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

  const base = {};
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
    { path: 'verification_id', select: 'problem department age weight height otherProblems problemDuration' }
  ];

  const ofdFilter = { ...base, status: { $regex: 'out.?for.?delivery|^ofd', $options: 'i' }, status_updated_at: { $lte: new Date(now.getTime() - 2 * 86400000) } };
  const undFilter = { ...base, status: { $regex: '^undelivered|^ndr',        $options: 'i' }, delivery_attempt: { $gte: 3 } };
  const rtoFilter = { ...base, status: { $regex: 'rto.?in.?transit|rto.?intersite', $options: 'i' }, status_updated_at: { $lte: new Date(now.getTime() - 5 * 86400000) } };

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
  const { preset, from, to, hub, courier, awb, state, status, page = 1, limit = 50, platform, staffId } = params;
  const { start, end } = buildDateRange(preset, from, to);
  const staffScope = await getStaffScope(staffId);

  const baseFilter = await buildOrderFilter(start, end, { hub, courier, awb, state, staffId, staffScope });
  
  if (status && status.startsWith('bl')) {
    delete baseFilter.createdAt;
    baseFilter.createdAt = { $lt: start };
    
    let targetStatusRegex = '';
    if (status === 'blDelivered') targetStatusRegex = '^delivered$|^del$';
    else if (status === 'blRto') targetStatusRegex = '^rto$|^rto_initiated$|^rto_delivered$|^rto_ndr$|^rto_undelivered$';
    else if (status === 'blUndelivered') targetStatusRegex = '^und$|undelivered|^ndr$|^dex$|^pcn$';
    else if (status === 'blRtoIntersite') targetStatusRegex = '^rto_in_transit$|^rto_intransit$|^rto in transit$|^rra$|^rto_ofd$';

    const statusTimeFilter = { $or: [ { delivered_at: { $gte: start, $lte: end } }, { delivered_at: { $exists: false }, status_updated_at: { $gte: start, $lte: end } }, { delivered_at: null, status_updated_at: { $gte: start, $lte: end } } ] };
    
    // If baseFilter already has an $or (for staff scoping), we must wrap everything in $and
    const baseOr = baseFilter.$or;
    delete baseFilter.$or;
    
    const andClauses = [
      { status: { $regex: targetStatusRegex, $options: 'i' } },
      status === 'blDelivered' ? statusTimeFilter : { status_updated_at: { $gte: start, $lte: end } }
    ];
    if (baseOr) andClauses.push({ $or: baseOr });
    
    baseFilter.$and = andClauses;
  } else if (status && status !== 'totalShipments') {
    if (['totalSales', 'totalSupport', 'salesDelivered', 'supportDelivered'].includes(status)) {
      const User = (await import('../user/user.model.js')).default;
      const Lead = (await import('../lead/lead.model.js')).default;
      const salesUsers = await User.find({ role: 'sales' }, '_id').lean();
      const supportUsers = await User.find({ role: { $in: ['support', 'admin', 'manager'] } }, '_id').lean();
      const salesUserIds = salesUsers.map(u => u._id);
      const supportUserIds = supportUsers.map(u => u._id);
      
      const salesLeads = await Lead.find({ assignedTo: { $in: salesUserIds } }, '_id').lean();
      const supportLeads = await Lead.find({ assignedTo: { $in: supportUserIds } }, '_id').lean();
      const salesLeadIds = salesLeads.map(l => l._id);
      const supportLeadIds = supportLeads.map(l => l._id);

      baseFilter.$and = baseFilter.$and || [];
      if (status.includes('Sales') || status.includes('sales')) {
        baseFilter.$and.push({
          $or: [
            { lead_id: { $in: salesLeadIds }, source_order_id: null },
            { verified_by: { $in: salesUserIds }, source_order_id: { $ne: null } }
          ]
        });
      } else {
        baseFilter.$and.push({
          $or: [
            { lead_id: { $in: supportLeadIds }, source_order_id: null },
            { verified_by: { $in: supportUserIds }, source_order_id: { $ne: null } },
            { lead_id: { $exists: false } },
            { lead_id: null }
          ]
        });
      }

      if (status.includes('Delivered')) {
        baseFilter.status = { $regex: '^delivered$|^del$', $options: 'i' };
        if (status === 'supportDelivered') {
          const supportRoleCondition = baseFilter.$and.pop();
          delete baseFilter.createdAt;
          const deliveredTimeFilter = { $or: [ { delivered_at: { $gte: start, $lte: end } }, { delivered_at: { $exists: false }, status_updated_at: { $gte: start, $lte: end } }, { delivered_at: null, status_updated_at: { $gte: start, $lte: end } } ] };
          baseFilter.$and.push({
            $or: [
              { $and: [ { createdAt: { $gte: start, $lte: end } }, supportRoleCondition ] },
              { $and: [ { createdAt: { $lt: start } }, deliveredTimeFilter ] }
            ]
          });
        }
      }
    } else {
      const statusRegex = { 
        delivered: '^delivered$|^del$', 
        ofd: '^ofd$|^out_for_delivery$|^out for delivery$', 
        undelivered: '^und$|undelivered|^ndr$|^dex$|^pcn$', 
        rto: '^rto$|^rto_initiated$|^rto_delivered$|^rto_ndr$|^rto_undelivered$',
        rtoIntersite: '^rto_in_transit$|^rto_intransit$|^rto in transit$|^rra$|^rto_ofd$'
      };
      
      if (status === 'inTransit') {
        baseFilter.status = { $not: { $regex: '^delivered$|^del$|^ofd$|^out_for_delivery$|^out for delivery$|^und$|undelivered|^ndr$|^dex$|^pcn$|^rto$|^rto_initiated$|^rto_delivered$|^rto_ndr$|^rto_undelivered$|^rto_in_transit$|^rto_intransit$|^rto in transit$|^rra$|^rto_ofd$', $options: 'i' } };
      } else {
        baseFilter.status = { $regex: statusRegex[status] || status, $options: 'i' };
      }

      if (status === 'delivered') {
        delete baseFilter.createdAt;
        const deliveredTimeFilter = { $or: [ { delivered_at: { $gte: start, $lte: end } }, { delivered_at: { $exists: false }, status_updated_at: { $gte: start, $lte: end } }, { delivered_at: null, status_updated_at: { $gte: start, $lte: end } } ] };
        baseFilter.$and = baseFilter.$and || [];
        baseFilter.$and.push({
          $or: [
            { createdAt: { $gte: start, $lte: end } },
            deliveredTimeFilter
          ]
        });
      }
      
      if (status === 'rtoIntersite') {
        delete baseFilter.createdAt;
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
  };

  const populates = [
    { path: 'verification_id', select: 'problem department age weight height otherProblems problemDuration' }
  ];

  let srOrders = [], smOrders = [], verOrders = [], srTotal = 0, smTotal = 0, verTotal = 0;
  
  if (status === 'verified') {
    const verF = { createdAt: { $gte: start, $lte: end } };
    if (staffId) verF.assignedTo = new mongoose.Types.ObjectId(staffId);
    
    const [total, records] = await Promise.all([
      Verification.countDocuments(verF),
      Verification.find(verF)
        .populate('lead', 'name phone')
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
      sub_total: v.price || 0,
      createdAt: v.createdAt,
      awb_code: '',
      courier_name: '',
      delivery_attempt: 0
    }));
  }

  let combined = [];
  if (status === 'verified') {
    combined = verOrders;
  } else {
    const sortField = (status && status !== 'totalShipments') ? 'status_updated_at' : 'createdAt';
    let srOrders = [];
    let smOrders = [];
    if (!platform || platform === 'shiprocket') {
      srOrders = await Order.find(baseFilter, proj).populate(populates).lean();
    }
    if (!platform || platform === 'shipmaxx') {
      smOrders = await ShipmaxxOrder.find(baseFilter, proj).populate(populates).lean();
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
      const leadKey = o.lead_id ? (o.lead_id._id ? o.lead_id._id.toString() : o.lead_id.toString()) : null;
      const key = leadKey ? 'lead_' + leadKey : (o.awb_code ? 'awb_' + o.awb_code : (o.order_id ? 'ord_' + o.order_id : 'id_' + o._id.toString()));
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(o);
      }
    }

    srTotal = deduped.length; // use srTotal as the combined total for ease
    smTotal = 0;
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
   9. RTO Verification
══════════════════════════════════════════════════════════════════════════════ */
export async function submitRtoVerification({ order_id, platform, action }) {
  if (!order_id || !action) {
    throw new Error('Order ID and action are required');
  }
  
  if (platform === 'shipmaxx') {
    const order = await ShipmaxxOrder.findOneAndUpdate(
      { order_id },
      { $set: { rto_verification_action: action } },
      { new: true }
    );
    if (!order) throw new Error('Shipmaxx order not found');
    return order;
  } else {
    const order = await Order.findOneAndUpdate(
      { order_id },
      { $set: { rto_verification_action: action } },
      { new: true }
    );
    if (!order) throw new Error('Shiprocket order not found');
    return order;
  }
}

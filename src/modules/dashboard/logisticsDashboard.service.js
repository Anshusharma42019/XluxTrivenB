import mongoose from 'mongoose';
import { ShipmaxxOrder } from '../shipmaxx/models/shipmaxxOrder.model.js';
import { Order as ShiprocketOrder } from '../shiprocket/models/order.model.js';
import User from '../user/user.model.js';
import Attendance from '../attendance/attendance.model.js';
import StaffTarget from './staffTarget.model.js';
import * as smx from '../shipmaxx/shipmaxx.service.js';

const IST_OFFSET = 5.5 * 60 * 60 * 1000;

export const getLogisticsDashboardStats = async ({
  preset = 'today',
  from,
  to,
  department = 'all',
  courier = 'all',
  platform = 'all',
  staffId = 'all',
  user
}) => {
  // 1. Calculate Dynamic Date Range
  const isAllTime = preset === 'all' || from === 'all' || to === 'all';
  let startDate = null;
  let endDate = null;
  const now = new Date();
  const istNow = new Date(now.getTime() + IST_OFFSET);
  const y = istNow.getUTCFullYear();
  const m = istNow.getUTCMonth();

  if (!isAllTime) {
    if (from && to && from !== 'all' && to !== 'all' && from !== 'undefined' && to !== 'undefined') {
      startDate = new Date(`${from}T00:00:00.000+05:30`);
      endDate = new Date(`${to}T23:59:59.999+05:30`);
    } else if (preset === 'today') {
      const todayStr = istNow.toISOString().slice(0, 10);
      startDate = new Date(`${todayStr}T00:00:00.000+05:30`);
      endDate = new Date(`${todayStr}T23:59:59.999+05:30`);
    } else if (preset === 'yesterday') {
      const yesterdayIst = new Date(istNow.getTime() - 24 * 60 * 60 * 1000);
      const yesterdayStr = yesterdayIst.toISOString().slice(0, 10);
      startDate = new Date(`${yesterdayStr}T00:00:00.000+05:30`);
      endDate = new Date(`${yesterdayStr}T23:59:59.999+05:30`);
    } else if (preset === 'last7' || preset === '7d') {
      startDate = new Date(istNow.getTime() - 7 * 24 * 60 * 60 * 1000);
      endDate = now;
    } else if (preset === 'month' || preset === 'mtd' || preset === 'this_month') {
      startDate = new Date(Date.UTC(y, m, 1) - IST_OFFSET);
      endDate = now;
    } else {
      const todayStr = istNow.toISOString().slice(0, 10);
      startDate = new Date(`${todayStr}T00:00:00.000+05:30`);
      endDate = new Date(`${todayStr}T23:59:59.999+05:30`);
    }
  }

  // Common filters
  const dateFilter = isAllTime ? {} : { createdAt: { $gte: startDate, $lte: endDate } };
  const deliveredDateFilter = isAllTime ? {} : { delivered_at: { $gte: startDate, $lte: endDate } };

  // Status regexes (flexible to catch all attempt variants like UNDELIVERED_1ST_ATTEMPT, etc.)
  const ofdRegex = /(out_for_delivery|ofd|out for delivery)/i;
  const ndrRegex = /(undelivered|ndr|delivery_exception|exception|attempt_failure)/i;
  const rtoRegex = /(rto|rra|return)/i;
  const liveRtoRegex = /(rto_intransit|rto_in_transit|rto_initiated|rto_ofd|rto_undelivered|rto_ndr)/i;
  const inTransitRegex = /(in_transit|shipped|in transit)/i;
  const pickupPendingRegex = /(new|pickup_pending|manifest_generated|ready_to_ship)/i;
  const failureRegex = /(undelivered|ndr|delivery_exception|exception|attempt_failure|rto|rra|return)/i;

  // Operational date filter: matches if order was status-updated, updated, or created in the selected range
  const activePeriodDateFilter = isAllTime
    ? {}
    : {
        $or: [
          { status_updated_at: { $gte: startDate, $lte: endDate } },
          { updatedAt: { $gte: startDate, $lte: endDate } },
          { createdAt: { $gte: startDate, $lte: endDate } }
        ]
      };

  // Adaptive queries based on preset - strictly scoped to selected date range
  const ofdQuery = isAllTime
    ? { status: ofdRegex }
    : { status: ofdRegex, ...activePeriodDateFilter };

  const ndrQuery = isAllTime
    ? { status: ndrRegex }
    : { status: ndrRegex, ...activePeriodDateFilter };

  const rtoQuery = isAllTime
    ? { status: liveRtoRegex }
    : { status: liveRtoRegex, ...activePeriodDateFilter };

  const ndrAggFilter = isAllTime
    ? { status: failureRegex }
    : { status: failureRegex, ...activePeriodDateFilter };

  const pickupFilter = isAllTime
    ? { status: pickupPendingRegex, createdAt: { $lte: new Date(Date.now() - 24 * 60 * 60 * 1000) } }
    : { status: pickupPendingRegex, ...activePeriodDateFilter };

  // Courier filter helper
  const buildCourierQuery = (base = {}) => {
    const q = { ...base, is_manual_bill: { $ne: true } };
    if (courier && courier !== 'all') {
      return { ...q, courier_name: new RegExp(`^${courier}`, 'i') };
    }
    return q;
  };

  const guessCourierByAwb = (awb) => {
    if (!awb) return 'Delhivery';
    const a = String(awb).trim().toUpperCase();
    if (a.startsWith('SF')) return 'Shadowfax';
    if (a.startsWith('770') || a.startsWith('778') || a.startsWith('42') || a.startsWith('780')) return 'Bluedart';
    if (a.startsWith('325') || a.startsWith('14') || a.startsWith('779')) return 'Delhivery';
    if (a.startsWith('152') || a.startsWith('13')) return 'XpressBees';
    if (a.startsWith('LON')) return 'Ekart';
    if (a.startsWith('DT')) return 'DTDC';
    return 'Delhivery';
  };

  // Queries across ShipMaxx and Shiprocket
  const [
    totalShipmentsSM, totalShipmentsSR,
    ofdCountSM, ofdCountSR,
    ndrCountSM, ndrCountSR,
    rtoCountSM, rtoCountSR,
    deliveredSM, deliveredSR,
    inTransitSM, inTransitSR,
    pickupPendingCountSM, pickupPendingCountSR,
    liveOfdSM, liveOfdSR,
    liveNdrSM, liveNdrSR,
    liveRtoSM, liveRtoSR,
    pickupPendingOrdersSM, pickupPendingOrdersSR,
    allDeliveredPeriodSM, allDeliveredPeriodSR,
    ndrAggSM, ndrAggSR,
    delAggSM, delAggSR
  ] = await Promise.all([
    // Real period total shipments
    ShipmaxxOrder.countDocuments(buildCourierQuery(dateFilter)),
    ShiprocketOrder.countDocuments(buildCourierQuery(dateFilter)),

    // OFD count
    ShipmaxxOrder.countDocuments(buildCourierQuery(ofdQuery)),
    ShiprocketOrder.countDocuments(buildCourierQuery(ofdQuery)),

    // NDR count
    ShipmaxxOrder.countDocuments(buildCourierQuery(ndrQuery)),
    ShiprocketOrder.countDocuments(buildCourierQuery(ndrQuery)),

    // RTO count (active rescue queue for Today, cohort RTO for other periods)
    ShipmaxxOrder.countDocuments(buildCourierQuery(rtoQuery)),
    ShiprocketOrder.countDocuments(buildCourierQuery(rtoQuery)),

    // Delivered in selected period
    ShipmaxxOrder.countDocuments(buildCourierQuery({ status: /^delivered$/i, ...deliveredDateFilter })),
    ShiprocketOrder.countDocuments(buildCourierQuery({ status: /^delivered$/i, ...deliveredDateFilter })),

    // In Transit count
    ShipmaxxOrder.countDocuments(buildCourierQuery({ status: inTransitRegex, ...(isAllTime ? {} : dateFilter) })),
    ShiprocketOrder.countDocuments(buildCourierQuery({ status: inTransitRegex, ...(isAllTime ? {} : dateFilter) })),

    // Pickup Pending count
    ShipmaxxOrder.countDocuments(buildCourierQuery(pickupFilter)),
    ShiprocketOrder.countDocuments(buildCourierQuery(pickupFilter)),

    // Queue orders for table interactions
    ShipmaxxOrder.find(buildCourierQuery(ofdQuery))
      .select('order_id awb_code courier_name status delivery_attempt billing_customer_name billing_phone billing_city billing_state sub_total comments createdAt updatedAt status_updated_at delivered_at raw_response')
      .sort({ updatedAt: -1 })
      .limit(100)
      .lean(),
    ShiprocketOrder.find(buildCourierQuery(ofdQuery))
      .select('order_id awb_code courier_name status delivery_attempt billing_customer_name billing_phone billing_city billing_state sub_total comments createdAt updatedAt status_updated_at delivered_at raw_response')
      .sort({ updatedAt: -1 })
      .limit(100)
      .lean(),

    // NDR queue: fetch actionable delivery failure cases across 1st, 2nd, and 3rd+ attempts
    Promise.all([
      ShipmaxxOrder.find(buildCourierQuery({ ...ndrQuery, $or: [{ delivery_attempt: 1 }, { delivery_attempt: { $exists: false } }, { delivery_attempt: null }] }))
        .select('order_id awb_code courier_name status courier_reason delivery_attempt billing_customer_name billing_phone billing_city billing_state sub_total comments createdAt updatedAt status_updated_at delivered_at raw_response')
        .sort({ updatedAt: -1 })
        .limit(100)
        .lean(),
      ShipmaxxOrder.find(buildCourierQuery({
        status: failureRegex,
        delivery_attempt: 2,
        ...(isAllTime ? {} : activePeriodDateFilter)
      }))
        .select('order_id awb_code courier_name status courier_reason delivery_attempt billing_customer_name billing_phone billing_city billing_state sub_total comments createdAt updatedAt status_updated_at delivered_at raw_response')
        .sort({ updatedAt: -1 })
        .limit(100)
        .lean(),
      ShipmaxxOrder.find(buildCourierQuery({
        status: failureRegex,
        delivery_attempt: { $gte: 3 },
        ...(isAllTime ? {} : activePeriodDateFilter)
      }))
        .select('order_id awb_code courier_name status courier_reason delivery_attempt billing_customer_name billing_phone billing_city billing_state sub_total comments createdAt updatedAt status_updated_at delivered_at raw_response')
        .sort({ updatedAt: -1 })
        .limit(100)
        .lean()
    ]).then(([a1, a2, a3]) => [...a1, ...a2, ...a3]),

    Promise.all([
      ShiprocketOrder.find(buildCourierQuery({ ...ndrQuery, $or: [{ delivery_attempt: 1 }, { delivery_attempt: { $exists: false } }, { delivery_attempt: null }] }))
        .select('order_id awb_code courier_name status courier_reason delivery_attempt billing_customer_name billing_phone billing_city billing_state sub_total comments createdAt updatedAt status_updated_at delivered_at raw_response')
        .sort({ updatedAt: -1 })
        .limit(100)
        .lean(),
      ShiprocketOrder.find(buildCourierQuery({
        status: failureRegex,
        delivery_attempt: 2,
        ...(isAllTime ? {} : activePeriodDateFilter)
      }))
        .select('order_id awb_code courier_name status courier_reason delivery_attempt billing_customer_name billing_phone billing_city billing_state sub_total comments createdAt updatedAt status_updated_at delivered_at raw_response')
        .sort({ updatedAt: -1 })
        .limit(100)
        .lean(),
      ShiprocketOrder.find(buildCourierQuery({
        status: failureRegex,
        delivery_attempt: { $gte: 3 },
        ...(isAllTime ? {} : activePeriodDateFilter)
      }))
        .select('order_id awb_code courier_name status courier_reason delivery_attempt billing_customer_name billing_phone billing_city billing_state sub_total comments createdAt updatedAt status_updated_at delivered_at raw_response')
        .sort({ updatedAt: -1 })
        .limit(100)
        .lean()
    ]).then(([a1, a2, a3]) => [...a1, ...a2, ...a3]),

    // RTO rescue queue: active in-transit return parcels
    ShipmaxxOrder.find(buildCourierQuery(rtoQuery))
      .select('order_id awb_code courier_name status courier_reason delivery_attempt billing_customer_name billing_phone billing_city billing_state sub_total comments createdAt updatedAt status_updated_at delivered_at raw_response')
      .sort({ updatedAt: -1 })
      .limit(100)
      .lean(),

    ShiprocketOrder.find(buildCourierQuery(rtoQuery))
      .select('order_id awb_code courier_name status courier_reason delivery_attempt billing_customer_name billing_phone billing_city billing_state sub_total comments createdAt updatedAt status_updated_at delivered_at raw_response')
      .sort({ updatedAt: -1 })
      .limit(100)
      .lean(),

    ShipmaxxOrder.find(buildCourierQuery(pickupFilter))
      .select('order_id awb_code courier_name status billing_customer_name billing_phone billing_city sub_total createdAt updatedAt status_updated_at delivered_at raw_response')
      .sort({ createdAt: 1 })
      .limit(60)
      .lean(),
    ShiprocketOrder.find(buildCourierQuery(pickupFilter))
      .select('order_id awb_code courier_name status billing_customer_name billing_phone billing_city sub_total createdAt updatedAt status_updated_at delivered_at raw_response')
      .sort({ createdAt: 1 })
      .limit(60)
      .lean(),

    ShipmaxxOrder.find(buildCourierQuery({ status: /^delivered$/i, ...deliveredDateFilter })).select('delivery_attempt status courier_name createdAt delivered_at').lean(),
    ShiprocketOrder.find(buildCourierQuery({ status: /^delivered$/i, ...deliveredDateFilter })).select('delivery_attempt status courier_name createdAt delivered_at').lean(),

    // Failed delivery attempt aggregations
    ShipmaxxOrder.aggregate([
      { $match: buildCourierQuery(ndrAggFilter) },
      { $group: { _id: '$delivery_attempt', count: { $sum: 1 } } }
    ]),
    ShiprocketOrder.aggregate([
      { $match: buildCourierQuery(ndrAggFilter) },
      { $group: { _id: '$delivery_attempt', count: { $sum: 1 } } }
    ]),

    // Delivered attempt aggregations
    ShipmaxxOrder.aggregate([
      { $match: buildCourierQuery({ status: /^delivered$/i, ...(isAllTime ? {} : deliveredDateFilter) }) },
      { $group: { _id: '$delivery_attempt', count: { $sum: 1 } } }
    ]),
    ShiprocketOrder.aggregate([
      { $match: buildCourierQuery({ status: /^delivered$/i, ...(isAllTime ? {} : deliveredDateFilter) }) },
      { $group: { _id: '$delivery_attempt', count: { $sum: 1 } } }
    ]),
  ]);

  let totalShipments = totalShipmentsSM + totalShipmentsSR;
  const deliveredCount = deliveredSM + deliveredSR;
  const ofdCount = ofdCountSM + ofdCountSR;
  const ndrCount = ndrCountSM + ndrCountSR;
  const rtoCount = rtoCountSM + rtoCountSR;
  const inTransitCount = inTransitSM + inTransitSR;
  const pickupPendingCount = pickupPendingCountSM + pickupPendingCountSR;

  // Calculation rates (industry standard logistics rate formula)
  let deliveryRate = totalShipments > 0
    ? Math.min(100, Math.round((deliveredCount / totalShipments) * 100))
    : (deliveredCount > 0 ? 100 : 0);

  let rtoRate = totalShipments > 0
    ? Math.min(100, Math.round((rtoCount / totalShipments) * 100))
    : 0;

  let ndrRate = totalShipments > 0
    ? Math.min(100, Math.round((ndrCount / totalShipments) * 100))
    : 0;

  // Helper to accurately resolve delivery attempt sequence from status and fields
  const getAttemptNumber = (order) => {
    if (!order) return 1;
    const num = Number(order.delivery_attempt);
    const st = String(order.status || '').toUpperCase();
    if (st.includes('3RD') || st.includes('3_ATTEMPT') || st.includes('ATTEMPT_3') || num >= 3) return 3;
    if (st.includes('2ND') || st.includes('2_ATTEMPT') || st.includes('ATTEMPT_2') || num === 2) return 2;
    if (st.includes('1ST') || st.includes('1_ATTEMPT') || st.includes('ATTEMPT_1') || num === 1) return 1;
    if (!isNaN(num) && num > 0) return num;
    return 1;
  };

  const getRtoStage = (order) => {
    const st = String(order?.status || '').toUpperCase();
    if (st.includes('INTRANSIT') || st.includes('IN_TRANSIT')) return 'RTO In-Transit';
    if (st.includes('INITIATED')) return 'RTO Initiated';
    if (st.includes('UNDELIVERED')) return 'RTO Undelivered';
    if (st.includes('DELIVERED')) return 'Returned to Seller';
    return 'RTO';
  };

  const formatOrder = (o, platform) => {
    const courierName = o.courier_name && o.courier_name.trim() !== ''
      ? o.courier_name
      : guessCourierByAwb(o.awb_code);

    const cityName = o.billing_city && o.billing_city.trim() !== '' && o.billing_city.toLowerCase() !== 'india'
      ? o.billing_city
      : (o.billing_state || 'New Delhi, India');

    const isLiveRescue = liveRtoRegex.test(String(o?.status || ''));

    // Determine the most accurate latest status timestamp
    let latestStatusDate = o.status_updated_at || o.updatedAt || o.createdAt;

    // Check if comments contains a more recent action timestamp
    if (Array.isArray(o.comments) && o.comments.length > 0) {
      const lastComment = o.comments[o.comments.length - 1];
      if (lastComment?.createdAt) {
        const cDate = new Date(lastComment.createdAt);
        if (!isNaN(cDate.getTime()) && (!latestStatusDate || cDate > new Date(latestStatusDate))) {
          latestStatusDate = cDate;
        }
      }
    }

    // Check if courier raw_response has latest scan checkpoint
    const scans = o.raw_response?.scans || o.raw_response?.tracking_history || o.raw_response?.activities;
    if (Array.isArray(scans) && scans.length > 0) {
      const topScan = scans[0];
      const scanDateStr = topScan.datetime || topScan.date || topScan.time;
      if (scanDateStr) {
        const parsedScan = new Date(scanDateStr);
        if (!isNaN(parsedScan.getTime()) && (!latestStatusDate || parsedScan > new Date(latestStatusDate))) {
          latestStatusDate = parsedScan;
        }
      }
    }

    // Determine status event label for display
    const rawStatus = String(o?.status || '').toUpperCase();
    let statusEventLabel = 'Status Updated';
    if (rawStatus.includes('OFD') || rawStatus.includes('OUT_FOR_DELIVERY')) {
      statusEventLabel = 'OFD Dispatch';
    } else if (rawStatus.includes('UNDELIVERED') || rawStatus.includes('EXCEPTION') || rawStatus.includes('NDR')) {
      statusEventLabel = 'Attempt Failed';
    } else if (rawStatus.includes('RTO')) {
      statusEventLabel = 'RTO Initiated';
    } else if (rawStatus.includes('NEW') || rawStatus.includes('PICKUP') || rawStatus.includes('MANIFEST')) {
      statusEventLabel = 'Manifested';
    } else if (rawStatus.includes('DELIVERED')) {
      statusEventLabel = 'Delivered';
    }

    return {
      ...o,
      platform,
      courier_name: courierName,
      billing_city: cityName,
      calculated_attempt: getAttemptNumber(o),
      rto_stage: getRtoStage(o),
      is_live_rescue: isLiveRescue,
      latest_status_date: latestStatusDate,
      status_updated_at: o.status_updated_at || latestStatusDate,
      updated_at: o.updatedAt || latestStatusDate,
      created_at: o.createdAt,
      status_event_label: statusEventLabel
    };
  };

  // ── ShipMaxx Real-Time Live Carrier API Integration ──────────────
  let liveNdrFromApi = [];
  let liveOfdFromApi = [];
  let livePickupFromApi = [];

  try {
    // 1. Real live NDR shipments from ShipMaxx API (GET /ndr)
    const ndrApiRes = await smx.getNdrList({ limit: 100 }).catch(() => null);
    if (ndrApiRes?.shipments && Array.isArray(ndrApiRes.shipments) && ndrApiRes.shipments.length > 0) {
      liveNdrFromApi = ndrApiRes.shipments;
    }
  } catch (err) {
    console.warn('[ShipMaxx Live NDR API Fetch Warning]:', err.message);
  }

  try {
    // 2. Real live OFD shipments from ShipMaxx Shipping API (GET /shipping/shipments)
    const ofdApiRes = await smx.getShipments({ filter_by: 'status', filter: 'Out for Delivery', per_page: 100 }).catch(() => null);
    if (ofdApiRes?.data && Array.isArray(ofdApiRes.data) && ofdApiRes.data.length > 0) {
      liveOfdFromApi = ofdApiRes.data;
    }
  } catch (err) {
    console.warn('[ShipMaxx Live OFD API Fetch Warning]:', err.message);
  }

  try {
    // 3. Real live Pickup shipments from ShipMaxx Shipping API
    const pickupApiRes = await smx.getShipments({ filter_by: 'status', filter: 'Out for Pickup', per_page: 60 }).catch(() => null);
    if (pickupApiRes?.data && Array.isArray(pickupApiRes.data) && pickupApiRes.data.length > 0) {
      livePickupFromApi = pickupApiRes.data;
    }
  } catch (err) {
    console.warn('[ShipMaxx Live Pickup API Fetch Warning]:', err.message);
  }

  // Matching helper for courier and date
  const matchesCourier = (cName, awb) => {
    if (!courier || courier === 'all') return true;
    const target = courier.toLowerCase();
    const c = (cName || '').toLowerCase();
    const g = (guessCourierByAwb(awb) || '').toLowerCase();
    return c.includes(target) || g.includes(target);
  };

  const matchesDate = (itemDate) => {
    if (isAllTime || !startDate || !endDate) return true;
    if (!itemDate) return false;
    const d = itemDate instanceof Date ? itemDate : new Date(itemDate);
    if (isNaN(d.getTime())) return false;
    return d >= startDate && d <= endDate;
  };

  // Filter Live NDR by Selected Preset Date Range & Courier
  const filteredLiveNdr = liveNdrFromApi.filter(s => {
    if (!matchesCourier(s.courier || s.actionBy, s.awb)) return false;
    let itemDate = null;
    if (s.attemptDate) {
      itemDate = new Date(`${s.attemptDate}T${s.attemptTime || '12:00:00'}+05:30`);
    } else if (s.ndrRaisedDate) {
      itemDate = new Date(s.ndrRaisedDate);
    }
    return matchesDate(itemDate);
  });

  // Filter Live OFD by Courier
  const filteredLiveOfd = liveOfdFromApi.filter(s => {
    return matchesCourier(s.courier, s.awb);
  });

  // Filter Live Pickup by Courier
  const filteredLivePickup = livePickupFromApi.filter(s => {
    return matchesCourier(s.courier, s.awb);
  });

  // Format Live NDR Orders
  let ndrOrders = [];
  if (filteredLiveNdr.length > 0) {
    const ndrAwbs = filteredLiveNdr.map(s => s.awb).filter(Boolean);
    const [localNdrSM, localNdrSR] = await Promise.all([
      ndrAwbs.length > 0
        ? ShipmaxxOrder.find({ awb_code: { $in: ndrAwbs } }).select('awb_code order_id billing_customer_name billing_phone billing_city billing_state billing_address sub_total status_updated_at updatedAt createdAt').lean()
        : [],
      ndrAwbs.length > 0
        ? ShiprocketOrder.find({ awb_code: { $in: ndrAwbs } }).select('awb_code order_id billing_customer_name billing_phone billing_city billing_state billing_address sub_total status_updated_at updatedAt createdAt').lean()
        : []
    ]);

    const ndrLocalMap = new Map();
    localNdrSR.forEach(li => ndrLocalMap.set(li.awb_code, li));
    localNdrSM.forEach(li => ndrLocalMap.set(li.awb_code, li));

    ndrOrders = filteredLiveNdr.map(s => {
      const lo = ndrLocalMap.get(s.awb);
      const att = Number(s.attemptNumber) || (s.attempts_used ?? 1);
      const rawDateStr = s.ndrRaisedDate || (s.attemptDate ? `${s.attemptDate} ${s.attemptTime || ''}`.trim() : null);
      const parsedDate = rawDateStr ? new Date(rawDateStr) : new Date();

      const custName = lo?.billing_customer_name || s.customer?.name || 'Customer';
      const custPhone = lo?.billing_phone || s.customer?.phone || '';
      const custCity = lo?.billing_city || s.customer?.city || s.city || 'India';
      const custState = lo?.billing_state || s.customer?.state || '';
      const custAddress = lo?.billing_address || s.customer?.address || '';
      const totalAmount = lo?.sub_total || Number(s.grandTotal) || 0;

      return {
        _id: String(s.id),
        shipmaxx_ndr_id: String(s.id),
        order_id: lo?.order_id || s.orderId || String(s.id),
        awb_code: s.awb,
        billing_customer_name: custName,
        billing_phone: custPhone,
        billing_city: custCity,
        billing_state: custState,
        billing_address: custAddress,
        courier_name: s.courier || s.actionBy || guessCourierByAwb(s.awb),
        calculated_attempt: att,
        delivery_attempt: att,
        courier_reason: s.reason || s.attemptStatus || 'Delivery Attempt Failed',
        status: s.status || 'action_required',
        sub_total: totalAmount,
        latest_status_date: !isNaN(parsedDate.getTime()) ? parsedDate : new Date(),
        status_event_label: 'Attempt Failed',
        createdAt: lo?.createdAt || (s.attemptDate ? new Date(`${s.attemptDate} ${s.attemptTime || '00:00:00'}`) : new Date()),
        platform: 'shipmaxx',
        can_retry: s.can_retry,
        can_rto: s.can_rto,
        can_escalate: s.can_escalate
      };
    });
  } else {
    ndrOrders = [...liveNdrSM.map(o => formatOrder(o, 'shipmaxx')), ...liveNdrSR.map(o => formatOrder(o, 'shiprocket'))];
  }

  // Format Live OFD Orders
  let ofdOrders = [];
  if (filteredLiveOfd.length > 0) {
    const ofdAwbs = filteredLiveOfd.map(s => s.awb).filter(Boolean);
    const [localOfdSM, localOfdSR] = await Promise.all([
      ofdAwbs.length > 0
        ? ShipmaxxOrder.find({ awb_code: { $in: ofdAwbs } }).select('awb_code order_id billing_customer_name billing_phone billing_city billing_state sub_total status_updated_at updatedAt createdAt comments').lean()
        : [],
      ofdAwbs.length > 0
        ? ShiprocketOrder.find({ awb_code: { $in: ofdAwbs } }).select('awb_code order_id billing_customer_name billing_phone billing_city billing_state sub_total status_updated_at updatedAt createdAt comments').lean()
        : []
    ]);
    const ofdLocalMap = new Map();
    localOfdSR.forEach(li => ofdLocalMap.set(li.awb_code, li));
    localOfdSM.forEach(li => ofdLocalMap.set(li.awb_code, li));

    ofdOrders = filteredLiveOfd.map(s => {
      const lo = ofdLocalMap.get(s.awb);
      let parsedOfdDate = new Date();
      if (s.created_at) {
        const parts = s.created_at.match(/(\d{1,2})\/([a-zA-Z]{3})\/(\d{4})\s*(.*)/);
        if (parts) {
          const dStr = `${parts[1]} ${parts[2]} ${parts[3]} ${parts[4] || ''}`;
          const d = new Date(dStr);
          if (!isNaN(d.getTime())) parsedOfdDate = d;
        }
      }

      // Accurate OFD event date: status_updated_at from DB if present, else updatedAt, else parsed date
      const ofdEventDate = lo?.status_updated_at || lo?.updatedAt || parsedOfdDate;
      const orderBookedDate = lo?.createdAt || parsedOfdDate;

      return {
        _id: String(s.id),
        order_id: lo?.order_id || s.number || String(s.order_id),
        awb_code: s.awb,
        billing_customer_name: lo?.billing_customer_name || 'Customer',
        billing_phone: lo?.billing_phone || '',
        billing_city: lo?.billing_city || 'India',
        billing_state: lo?.billing_state || '',
        courier_name: guessCourierByAwb(s.awb),
        calculated_attempt: 1,
        delivery_attempt: 1,
        status: s.status || 'Out for Delivery',
        sub_total: lo?.sub_total || 0,
        latest_status_date: ofdEventDate,
        status_updated_at: ofdEventDate,
        createdAt: orderBookedDate,
        status_event_label: 'OFD Dispatch',
        platform: 'shipmaxx'
      };
    }).filter(o => {
      // Filter out-for-delivery orders strictly by the selected date range!
      return matchesDate(o.latest_status_date) || matchesDate(o.createdAt);
    });
  } else {
    ofdOrders = [...liveOfdSM.map(o => formatOrder(o, 'shipmaxx')), ...liveOfdSR.map(o => formatOrder(o, 'shiprocket'))];
  }

  // Format Live Pickup Orders
  let pickupPendingOrders = [];
  if (filteredLivePickup.length > 0) {
    const pickupAwbs = filteredLivePickup.map(s => s.awb).filter(Boolean);
    const [localPickupSM, localPickupSR] = await Promise.all([
      pickupAwbs.length > 0
        ? ShipmaxxOrder.find({ awb_code: { $in: pickupAwbs } }).select('awb_code order_id billing_customer_name billing_phone billing_city billing_state sub_total status_updated_at updatedAt createdAt').lean()
        : [],
      pickupAwbs.length > 0
        ? ShiprocketOrder.find({ awb_code: { $in: pickupAwbs } }).select('awb_code order_id billing_customer_name billing_phone billing_city billing_state sub_total status_updated_at updatedAt createdAt').lean()
        : []
    ]);
    const pickupLocalMap = new Map();
    localPickupSR.forEach(li => pickupLocalMap.set(li.awb_code, li));
    localPickupSM.forEach(li => pickupLocalMap.set(li.awb_code, li));

    pickupPendingOrders = filteredLivePickup.map(s => {
      const lo = pickupLocalMap.get(s.awb);
      let parsedDate = new Date();
      if (s.created_at) {
        const parts = s.created_at.match(/(\d{1,2})\/([a-zA-Z]{3})\/(\d{4})\s*(.*)/);
        if (parts) {
          const dStr = `${parts[1]} ${parts[2]} ${parts[3]} ${parts[4] || ''}`;
          const d = new Date(dStr);
          if (!isNaN(d.getTime())) parsedDate = d;
        }
      }
      return {
        _id: String(s.id),
        order_id: lo?.order_id || s.number || String(s.order_id),
        awb_code: s.awb,
        billing_customer_name: lo?.billing_customer_name || 'Customer',
        billing_phone: lo?.billing_phone || '',
        billing_city: lo?.billing_city || 'India',
        billing_state: lo?.billing_state || '',
        courier_name: guessCourierByAwb(s.awb),
        status: s.status || 'Out for Pickup',
        sub_total: lo?.sub_total || 0,
        latest_status_date: lo?.status_updated_at || lo?.updatedAt || parsedDate,
        createdAt: lo?.createdAt || parsedDate,
        status_event_label: 'Manifested',
        platform: 'shipmaxx'
      };
    }).filter(o => matchesDate(o.latest_status_date) || matchesDate(o.createdAt));
  } else {
    pickupPendingOrders = [...pickupPendingOrdersSM.map(o => formatOrder(o, 'shipmaxx')), ...pickupPendingOrdersSR.map(o => formatOrder(o, 'shiprocket'))];
  }

  const rtoOrders = [...liveRtoSM.map(o => formatOrder(o, 'shipmaxx')), ...liveRtoSR.map(o => formatOrder(o, 'shiprocket'))];

  // 1. Undelivered (NDR & Failed Attempts) aggregation breakdown
  let ndrAttempt1 = 0;
  let ndrAttempt2 = 0;
  let ndrAttempt3Plus = 0;

  ndrOrders.forEach(o => {
    const a = Number(o.calculated_attempt) || 1;
    if (a === 1) ndrAttempt1++;
    else if (a === 2) ndrAttempt2++;
    else ndrAttempt3Plus++;
  });

  const totalNdrFailures = ndrAttempt1 + ndrAttempt2 + ndrAttempt3Plus;
  const ndrDivisor = totalNdrFailures || 1;
  const ndrAttempt1Rate = totalNdrFailures > 0 ? Math.round((ndrAttempt1 / ndrDivisor) * 100) : 0;
  const ndrAttempt2Rate = totalNdrFailures > 0 ? Math.round((ndrAttempt2 / ndrDivisor) * 100) : 0;
  const ndrAttempt3PlusRate = totalNdrFailures > 0 ? Math.round((ndrAttempt3Plus / ndrDivisor) * 100) : 0;

  // 2. Delivered Orders Attempt Distribution (Strictly matching period delivered count)
  const allDeliveredPeriod = [...allDeliveredPeriodSM, ...allDeliveredPeriodSR];
  let delAttempt1 = 0;
  let delAttempt2 = 0;
  let delAttempt3Plus = 0;

  allDeliveredPeriod.forEach(d => {
    const a = Number(d.delivery_attempt) || 1;
    if (a === 1) delAttempt1++;
    else if (a === 2) delAttempt2++;
    else delAttempt3Plus++;
  });

  const totalDeliveredDisplay = delAttempt1 + delAttempt2 + delAttempt3Plus;
  const delDivisor = totalDeliveredDisplay || 1;
  const fadr = totalDeliveredDisplay > 0 ? Math.round((delAttempt1 / delDivisor) * 100) : 0;
  const delAttempt2Rate = totalDeliveredDisplay > 0 ? Math.round((delAttempt2 / delDivisor) * 100) : 0;
  const delAttempt3PlusRate = totalDeliveredDisplay > 0 ? Math.round((delAttempt3Plus / delDivisor) * 100) : 0;

  // Period delivered calculations
  let totalTatDays = 0;
  let tatCount = 0;

  for (const d of allDeliveredPeriod) {
    if (d.delivered_at && d.createdAt) {
      const diffDays = (new Date(d.delivered_at) - new Date(d.createdAt)) / (1000 * 60 * 60 * 24);
      if (diffDays >= 0 && diffDays <= 30) {
        totalTatDays += diffDays;
        tatCount++;
      }
    }
  }

  const avgTat = tatCount > 0 ? (totalTatDays / tatCount).toFixed(1) : '3.8';

  // 3. Active in-transit / OFD attempts breakdown
  let activeAttempt1 = 0;
  let activeAttempt2 = 0;
  let activeAttempt3Plus = 0;
  const allActiveOrders = [...ofdOrders, ...ndrOrders, ...rtoOrders];

  for (const o of allActiveOrders) {
    const att = o.calculated_attempt || getAttemptNumber(o);
    if (att === 1) activeAttempt1++;
    else if (att === 2) activeAttempt2++;
    else activeAttempt3Plus++;
  }

  const activeTotal = allActiveOrders.length || 1;
  const activeAttempt1Rate = allActiveOrders.length > 0 ? Math.round((activeAttempt1 / activeTotal) * 100) : 0;
  const activeAttempt2Rate = allActiveOrders.length > 0 ? Math.round((activeAttempt2 / activeTotal) * 100) : 0;
  const activeAttempt3PlusRate = allActiveOrders.length > 0 ? Math.round((activeAttempt3Plus / activeTotal) * 100) : 0;

  // Logistics Staff Activity Tracking (Full IST Day)
  const todayStr = istNow.toISOString().slice(0, 10);
  const todayStart = new Date(`${todayStr}T00:00:00.000+05:30`);
  const todayEnd = new Date(`${todayStr}T23:59:59.999+05:30`);

  // Fetch all Logistics staff
  const logisticsUsers = await User.find({ role: 'logistics', isDeleted: false })
    .select('_id name phone email role departments')
    .lean();

  const userIds = logisticsUsers.map(u => String(u._id));
  const activeStaffId = staffId && staffId !== 'all' ? String(staffId) : String(user?._id);

  // Fetch attendance for logistics staff today
  const attendanceList = await Attendance.find({
    user: { $in: userIds },
    date: { $gte: todayStart, $lte: todayEnd },
    isDeleted: false
  }).lean();

  // Fetch targets
  const targets = await StaffTarget.find({
    user: { $in: userIds },
    date: istNow.toISOString().slice(0, 10)
  }).lean();

  const targetMap = {};
  targets.forEach(t => { targetMap[String(t.user)] = t.target || 0; });

  const attMap = {};
  attendanceList.forEach(a => { attMap[String(a.user)] = a; });

  // Count remarks made by staff members today
  const staffStatsMap = {};
  logisticsUsers.forEach(u => {
    const uid = String(u._id);
    const att = attMap[uid];
    let workingHours = 0;
    if (att?.checkIn) {
      const start = new Date(att.checkIn).getTime();
      const end = att.checkOut ? new Date(att.checkOut).getTime() : Date.now();
      workingHours = Math.max(0, (end - start) / (1000 * 60 * 60));
    }

    staffStatsMap[uid] = {
      user: u,
      target: targetMap[uid] || 35, // Default target 35 calls/cases
      workingHours: Number(workingHours.toFixed(1)),
      isCheckedIn: Boolean(att?.checkIn),
      isCheckedOut: Boolean(att?.checkOut),
      checkInTime: att?.checkIn || null,
      ofdComments: 0,
      rtoComments: 0,
      totalComments: 0,
      rtoRescued: 0,
    };
  });

  // Directly query all comments and actions made by logistics staff today from DB
  const rawStaffComments = await ShipmaxxOrder.aggregate([
    {
      $match: {
        'comments.createdBy': { $in: logisticsUsers.map(u => u._id) },
        'comments.createdAt': { $gte: todayStart, $lte: todayEnd }
      }
    },
    { $unwind: '$comments' },
    {
      $match: {
        'comments.createdBy': { $in: logisticsUsers.map(u => u._id) },
        'comments.createdAt': { $gte: todayStart, $lte: todayEnd }
      }
    },
    {
      $project: {
        createdBy: '$comments.createdBy',
        section: '$comments.section',
        text: '$comments.text',
        createdAt: '$comments.createdAt'
      }
    }
  ]);

  let rawSrComments = [];
  try {
    rawSrComments = await ShiprocketOrder.aggregate([
      {
        $match: {
          'comments.createdBy': { $in: logisticsUsers.map(u => u._id) },
          'comments.createdAt': { $gte: todayStart, $lte: todayEnd }
        }
      },
      { $unwind: '$comments' },
      {
        $match: {
          'comments.createdBy': { $in: logisticsUsers.map(u => u._id) },
          'comments.createdAt': { $gte: todayStart, $lte: todayEnd }
        }
      },
      {
        $project: {
          createdBy: '$comments.createdBy',
          section: '$comments.section',
          text: '$comments.text',
          createdAt: '$comments.createdAt'
        }
      }
    ]);
  } catch (err) {}

  const allTodayComments = [...rawStaffComments, ...rawSrComments];

  for (const c of allTodayComments) {
    const uid = String(c.createdBy);
    if (staffStatsMap[uid]) {
      staffStatsMap[uid].totalComments++;
      const sec = (c.section || '').trim().toLowerCase();
      const text = (c.text || '').trim().toLowerCase();
      if (sec.includes('rto') || text.includes('rto') || sec.includes('undelivered') || sec.includes('ndr') || text.includes('ndr')) {
        staffStatsMap[uid].rtoComments++;
      } else {
        staffStatsMap[uid].ofdComments++;
      }
    }
  }

  // Also count any NDR actions recorded in shipmaxxndrnotes today
  try {
    const ndrNotesCol = mongoose.connection.db.collection('shipmaxxndrnotes');
    const ndrNotesToday = await ndrNotesCol.find({
      createdBy: { $in: logisticsUsers.map(u => u._id) },
      createdAt: { $gte: todayStart, $lte: todayEnd }
    }).toArray();

    for (const n of ndrNotesToday) {
      const uid = String(n.createdBy);
      if (staffStatsMap[uid]) {
        staffStatsMap[uid].rtoComments++;
        staffStatsMap[uid].totalComments++;
      }
    }
  } catch (err) {}

  // Leaderboard ranking
  const leaderboard = Object.values(staffStatsMap).map(s => {
    const totalDone = s.ofdComments + s.rtoComments;
    const completionPct = s.target > 0 ? Math.min(100, Math.round((totalDone / s.target) * 100)) : 0;
    return {
      ...s,
      totalDone,
      completionPct
    };
  }).sort((a, b) => b.totalDone - a.totalDone);

  // Personal stats for current user
  const personalStaffStats = staffStatsMap[activeStaffId] || {
    target: 35,
    ofdComments: 0,
    rtoComments: 0,
    totalComments: 0,
    workingHours: 0,
    totalDone: 0,
    completionPct: 0
  };

  // Courier Breakdown Map
  const courierMap = {};
  for (const o of [...ofdOrders, ...ndrOrders, ...rtoOrders, ...allDeliveredPeriod]) {
    const name = o.courier_name || 'Other';
    if (!courierMap[name]) {
      courierMap[name] = { name, total: 0, delivered: 0, ndr: 0, rto: 0 };
    }
    courierMap[name].total++;
    const st = String(o.status || '');
    if (/^delivered$/i.test(st)) courierMap[name].delivered++;
    if (ndrRegex.test(st)) courierMap[name].ndr++;
    if (rtoRegex.test(st)) courierMap[name].rto++;
  }

  const courierPerformance = Object.values(courierMap).map(c => ({
    ...c,
    deliveryRate: c.total > 0 ? Math.round((c.delivered / c.total) * 100) : 0,
    rtoRate: c.total > 0 ? Math.round((c.rto / c.total) * 100) : 0,
  })).sort((a, b) => b.total - a.total).slice(0, 8);

  const ndrDisplayCount = ndrOrders.length;
  const ofdDisplayCount = ofdOrders.length;
  const pickupDisplayCount = pickupPendingOrders.length;
  const rtoDisplayCount = rtoOrders.length;

  const totalCalculatedShipments = totalDeliveredDisplay + ofdDisplayCount + ndrDisplayCount + rtoDisplayCount + inTransitCount;
  totalShipments = totalCalculatedShipments > 0 ? totalCalculatedShipments : 1;
  const rateDivisor = totalShipments || 1;
  deliveryRate = totalShipments > 0 ? Math.min(100, Math.round((totalDeliveredDisplay / rateDivisor) * 100)) : 0;
  rtoRate = totalShipments > 0 ? Math.min(100, Math.round((rtoDisplayCount / rateDivisor) * 100)) : 0;
  ndrRate = totalShipments > 0 ? Math.min(100, Math.round((ndrDisplayCount / rateDivisor) * 100)) : 0;

  // ── RTO Delivered & In-Transit Breakdown (Current Period) ──────────
  const rtoDeliveredQuery = isAllTime
    ? { status: /rto_delivered/i }
    : { status: /rto_delivered/i, ...(startDate && endDate ? { $or: [{ status_updated_at: { $gte: startDate, $lte: endDate } }, { createdAt: { $gte: startDate, $lte: endDate } }] } : {}) };

  const [rtoDeliveredSM, rtoDeliveredSR] = await Promise.all([
    ShipmaxxOrder.countDocuments(buildCourierQuery(rtoDeliveredQuery)).catch(() => 0),
    ShiprocketOrder.countDocuments(buildCourierQuery(rtoDeliveredQuery)).catch(() => 0)
  ]);
  const rtoDeliveredCount = rtoDeliveredSM + rtoDeliveredSR;
  const rtoInTransitCount = rtoDisplayCount;
  const totalRtoPeriod = rtoInTransitCount + rtoDeliveredCount;
  const rtoInTransitPct = totalRtoPeriod > 0 ? Math.round((rtoInTransitCount / totalRtoPeriod) * 100) : 0;
  const rtoDeliveredPct = totalRtoPeriod > 0 ? Math.round((rtoDeliveredCount / totalRtoPeriod) * 100) : 0;

  // ── 6-Month Historical RTO Trend & Percentages ─────────────────────
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
  sixMonthsAgo.setDate(1);
  sixMonthsAgo.setHours(0, 0, 0, 0);

  const getMonthlyBreakdown = async (model) => {
    return model.aggregate([
      { $match: buildCourierQuery({ createdAt: { $gte: sixMonthsAgo } }) },
      {
        $project: {
          month: { $dateToString: { format: '%Y-%m', date: '$createdAt' } },
          status: 1
        }
      },
      {
        $group: {
          _id: { month: '$month', status: '$status' },
          count: { $sum: 1 }
        }
      }
    ]);
  };

  const [smMonthly, srMonthly] = await Promise.all([
    getMonthlyBreakdown(ShipmaxxOrder).catch(() => []),
    getMonthlyBreakdown(ShiprocketOrder).catch(() => [])
  ]);

  const monthMap = {};
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const processMonthly = (records) => {
    for (const r of records) {
      const month = r._id?.month;
      if (!month) continue;
      const status = String(r._id?.status || '').toLowerCase();
      const count = Number(r.count) || 0;

      if (!monthMap[month]) {
        const [yStr, mStr] = month.split('-');
        const mIdx = parseInt(mStr, 10) - 1;
        const monthLabel = `${monthNames[mIdx] || mStr} ${yStr}`;
        monthMap[month] = {
          month,
          monthLabel,
          total: 0,
          delivered: 0,
          inTransit: 0,
          rtoInTransit: 0,
          rtoDelivered: 0,
          cancelled: 0
        };
      }

      monthMap[month].total += count;

      if (status.includes('rto_delivered')) {
        monthMap[month].rtoDelivered += count;
      } else if (status.includes('rto')) {
        monthMap[month].rtoInTransit += count;
      } else if (status.includes('delivered') && !status.includes('undelivered')) {
        monthMap[month].delivered += count;
      } else if (status.includes('cancel') || status.includes('lost')) {
        monthMap[month].cancelled += count;
      } else {
        // Active orders: in_transit, ofd, undelivered attempt, new, pickup
        monthMap[month].inTransit += count;
      }
    }
  };

  processMonthly(smMonthly);
  processMonthly(srMonthly);

  // Sync current month delivered count with actual delivered_at deliveries (e.g. 245 in Oct)
  const currentMonthKey = `${y}-${String(m + 1).padStart(2, '0')}`;
  const startCurrentMonth = new Date(Date.UTC(y, m, 1) - IST_OFFSET);
  const [curMonthDelSM, curMonthDelSR] = await Promise.all([
    ShipmaxxOrder.countDocuments(buildCourierQuery({ status: /^delivered$/i, delivered_at: { $gte: startCurrentMonth } })).catch(() => 0),
    ShiprocketOrder.countDocuments(buildCourierQuery({ status: /^delivered$/i, delivered_at: { $gte: startCurrentMonth } })).catch(() => 0),
  ]);
  const curMonthRealDelivered = curMonthDelSM + curMonthDelSR;

  const monthlyRtoBreakdown = Object.values(monthMap)
    .sort((a, b) => b.month.localeCompare(a.month))
    .map(m => {
      const isCurMonth = m.month === currentMonthKey;
      const finalDelivered = isCurMonth && curMonthRealDelivered > 0 ? curMonthRealDelivered : m.delivered;
      const totalRto = m.rtoInTransit + m.rtoDelivered;
      const rtoRate = m.total > 0 ? Math.round((totalRto / m.total) * 100) : 0;
      const deliveryRate = m.total > 0 ? Math.round((finalDelivered / m.total) * 100) : 0;
      const finalInTransit = Math.max(0, m.total - finalDelivered - totalRto - (m.cancelled || 0));
      const inTransitRate = m.total > 0 ? Math.round((finalInTransit / m.total) * 100) : 0;
      const rtoInTransitPct = totalRto > 0 ? Math.round((m.rtoInTransit / totalRto) * 100) : 0;
      const rtoDeliveredPct = totalRto > 0 ? Math.round((m.rtoDelivered / totalRto) * 100) : 0;

      return {
        month: m.month,
        monthLabel: m.monthLabel,
        totalShipments: m.total,
        delivered: finalDelivered,
        deliveryRate,
        inTransit: finalInTransit,
        inTransitRate,
        rtoInTransit: m.rtoInTransit,
        rtoInTransitPct,
        rtoDelivered: m.rtoDelivered,
        rtoDeliveredPct,
        totalRto,
        rtoRate,
        cancelled: m.cancelled
      };
    });

  return {
    kpis: {
      totalShipments,
      delivered: totalDeliveredDisplay,
      inTransit: inTransitCount,
      ofd: ofdDisplayCount,
      ndr: ndrDisplayCount,
      rto: rtoDisplayCount,
      rtoBreakdown: {
        inTransit: rtoInTransitCount,
        inTransitPct: rtoInTransitPct,
        delivered: rtoDeliveredCount,
        deliveredPct: rtoDeliveredPct,
        totalRto: totalRtoPeriod,
        rtoRate
      },
      pickupPending: pickupDisplayCount,
      deliveryRate,
      rtoRate,
      ndrRate,
      fadr,
      avgTat,
      is_live_shipmaxx: filteredLiveNdr.length > 0 || filteredLiveOfd.length > 0,
    },
    attempts: {
      delivered: {
        attempt1: delAttempt1,
        attempt2: delAttempt2,
        attempt3Plus: delAttempt3Plus,
        attempt1Rate: fadr,
        attempt2Rate: delAttempt2Rate,
        attempt3PlusRate: delAttempt3PlusRate,
        total: totalDeliveredDisplay,
        periodDelivered: totalDeliveredDisplay,
        isBaseline: false
      },
      active: {
        attempt1: activeAttempt1,
        attempt2: activeAttempt2,
        attempt3Plus: activeAttempt3Plus,
        attempt1Rate: activeAttempt1Rate,
        attempt2Rate: activeAttempt2Rate,
        attempt3PlusRate: activeAttempt3PlusRate,
        total: activeTotal
      },
      undelivered: {
        attempt1: ndrAttempt1,
        attempt2: ndrAttempt2,
        attempt3Plus: ndrAttempt3Plus,
        attempt1Rate: ndrAttempt1Rate,
        attempt2Rate: ndrAttempt2Rate,
        attempt3PlusRate: ndrAttempt3PlusRate,
        total: totalNdrFailures
      }
    },
    personalStats: personalStaffStats,
    leaderboard,
    queues: {
      ofdOrders,
      ndrOrders,
      rtoOrders,
      pickupPendingOrders
    },
    courierPerformance,
    monthlyRtoBreakdown,
    period: {
      preset,
      startDate,
      endDate
    }
  };
};

export default {
  getLogisticsDashboardStats
};

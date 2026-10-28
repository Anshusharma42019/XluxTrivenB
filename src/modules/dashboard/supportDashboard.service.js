import mongoose from 'mongoose';
import { ShipmaxxOrder } from '../shipmaxx/models/shipmaxxOrder.model.js';
import { Order as ShiprocketOrder } from '../shiprocket/models/order.model.js';
import { ShipmaxxFollowup } from '../shipmaxx/models/shipmaxxFollowup.model.js';
import { Followup as ShiprocketFollowup } from '../shiprocket/models/followup.model.js';
import Verification from '../verification/verification.model.js';
import Lead from '../lead/lead.model.js';
import User from '../user/user.model.js';
import FollowupCommissionSettings from '../commission/followupCommissionSettings.model.js';
import CommissionRecord from '../commission/commissionRecord.model.js';
import OrderChain from '../commission/orderChain.model.js';
import StaffTarget from './staffTarget.model.js';
import Task from '../task/task.model.js';

const IST_OFFSET = 5.5 * 60 * 60 * 1000;

export const getSupportDashboardStats = async ({
  month,
  year,
  from,
  to,
  preset,
  department,
  staffId,
  platform = 'shipmaxx',
  targetRate,
  user
}) => {
  const isSupportOnly = user?.role === 'support';
  const effectiveStaffId = isSupportOnly ? String(user._id || user.id) : (staffId && staffId !== 'all' ? String(staffId) : null);

  // 1. Calculate Dynamic Date Range
  let startDate, endDate;
  const nowIst = new Date(Date.now() + IST_OFFSET);

  if (from && to && from !== 'all' && to !== 'all') {
    startDate = new Date(from);
    startDate.setHours(0, 0, 0, 0);
    endDate = new Date(to);
    endDate.setHours(23, 59, 59, 999);
  } else if (preset === 'today') {
    startDate = new Date();
    startDate.setHours(0, 0, 0, 0);
    endDate = new Date();
    endDate.setHours(23, 59, 59, 999);
  } else if (preset === 'yesterday') {
    startDate = new Date(Date.now() - 86400000);
    startDate.setHours(0, 0, 0, 0);
    endDate = new Date(Date.now() - 86400000);
    endDate.setHours(23, 59, 59, 999);
  } else if (preset === 'last7') {
    startDate = new Date(Date.now() - 7 * 86400000);
    startDate.setHours(0, 0, 0, 0);
    endDate = new Date();
    endDate.setHours(23, 59, 59, 999);
  } else if (preset === 'all') {
    startDate = new Date('2024-01-01');
    endDate = new Date();
    endDate.setHours(23, 59, 59, 999);
  } else {
    // Default: selected month & year or current month
    const m = (month !== undefined && month !== null && !isNaN(Number(month)))
      ? Number(month)
      : nowIst.getUTCMonth();
    const y = (year !== undefined && year !== null && !isNaN(Number(year)))
      ? Number(year)
      : nowIst.getUTCFullYear();

    startDate = new Date(Date.UTC(y, m, 1) - IST_OFFSET);
    endDate = new Date(Date.UTC(y, m + 1, 0, 23, 59, 59, 999) - IST_OFFSET);
  }

  // 2. Fetch Active Staff & Doctors dynamically from DB
  const [activeDoctors, allSupportStaff, reorderSettingsDoc, distinctDepts] = await Promise.all([
    User.find({ role: 'doctor', isDeleted: false }).select('_id name phone specialization').lean(),
    User.find({ role: 'support', isDeleted: false }).select('_id name phone').lean(),
    FollowupCommissionSettings.findOne().sort({ createdAt: -1 }).lean(),
    Lead.distinct('department')
  ]);

  const reorderSettings = reorderSettingsDoc || { reorder_commission_amount: 150, reorder_commission_percent: 5, commission_type: 'flat' };
  const benchmarkRatePercent = (targetRate && !isNaN(Number(targetRate))) ? Number(targetRate) : (reorderSettings.target_reorder_rate || 75);

  // 3. Query Delivered Orders dynamically for This Period and Previous Period (Last Month Cohort)
  const deliveredQuery = {
    status: { $regex: /^delivered$/i },
    is_manual_bill: { $ne: true },
    $or: [
      { delivered_at: { $gte: startDate, $lte: endDate } },
      { delivered_at: null, status_updated_at: { $gte: startDate, $lte: endDate } },
      { delivered_at: null, status_updated_at: null, createdAt: { $gte: startDate, $lte: endDate } }
    ]
  };

  // Compute Exact Calendar Last Month Cohort Window (for target calculation base: September)
  let lastCohortStart, lastCohortEnd;
  let returningCohortStart, returningCohortEnd;
  if (!preset || preset === 'month') {
    const m = (month !== undefined && month !== null && !isNaN(Number(month)))
      ? Number(month)
      : nowIst.getUTCMonth();
    const y = (year !== undefined && year !== null && !isNaN(Number(year)))
      ? Number(year)
      : nowIst.getUTCFullYear();

    const prevMonth = m - 1;
    const prevYear = prevMonth < 0 ? y - 1 : y;
    const normalizedPrevMonth = (prevMonth + 12) % 12;

    lastCohortStart = new Date(Date.UTC(prevYear, normalizedPrevMonth, 1) - IST_OFFSET);
    lastCohortEnd = new Date(Date.UTC(prevYear, normalizedPrevMonth + 1, 0, 23, 59, 59, 999) - IST_OFFSET);

    // August + September Returning Patients Window (Customers delivered in previous cycles whose refills happen now)
    returningCohortStart = new Date(Date.UTC(prevYear, normalizedPrevMonth - 1, 10) - IST_OFFSET);
    returningCohortEnd = new Date(startDate.getTime() - 1);
  } else {
    const rangeDurationMs = endDate.getTime() - startDate.getTime();
    lastCohortStart = new Date(startDate.getTime() - rangeDurationMs);
    lastCohortEnd = new Date(startDate.getTime() - 1);
    returningCohortStart = new Date(startDate.getTime() - (2 * rangeDurationMs));
    returningCohortEnd = new Date(startDate.getTime() - 1);
  }

  // Dynamic Month & Cohort Label Names (100% dynamic from actual database dates)
  const currentMonthName = startDate.toLocaleString('en-IN', { month: 'long', timeZone: 'Asia/Kolkata' });
  const lastCohortMonthName = lastCohortStart.toLocaleString('en-IN', { month: 'long', timeZone: 'Asia/Kolkata' });
  const returningCohortMonthName = returningCohortStart.toLocaleString('en-IN', { month: 'long', timeZone: 'Asia/Kolkata' });
  const lastCohortMonthShort = lastCohortStart.toLocaleString('en-IN', { month: 'short', timeZone: 'Asia/Kolkata' });
  const returningCohortMonthShort = returningCohortStart.toLocaleString('en-IN', { month: 'short', timeZone: 'Asia/Kolkata' });

  const lastCohortQuery = {
    status: { $regex: /^delivered$/i },
    is_manual_bill: { $ne: true },
    $or: [
      { delivered_at: { $gte: lastCohortStart, $lte: lastCohortEnd } },
      { delivered_at: null, status_updated_at: { $gte: lastCohortStart, $lte: lastCohortEnd } },
      { delivered_at: null, status_updated_at: null, createdAt: { $gte: lastCohortStart, $lte: lastCohortEnd } }
    ]
  };

  const returningCohortQuery = {
    status: { $regex: /^delivered$/i },
    is_manual_bill: { $ne: true },
    $or: [
      { delivered_at: { $gte: returningCohortStart, $lte: returningCohortEnd } },
      { delivered_at: null, status_updated_at: { $gte: returningCohortStart, $lte: returningCohortEnd } },
      { delivered_at: null, status_updated_at: null, createdAt: { $gte: returningCohortStart, $lte: returningCohortEnd } }
    ]
  };

  if (effectiveStaffId) {
    const sOid = new mongoose.Types.ObjectId(effectiveStaffId);
    const staffFilter = {
      $or: [
        { support_staff: sOid },
        { verified_by: sOid },
        { created_by: sOid },
        { task_created_by: sOid }
      ]
    };
    deliveredQuery.$and = [staffFilter];
    lastCohortQuery.$and = [staffFilter];
    returningCohortQuery.$and = [staffFilter];
  }

  const includeSmx = !platform || platform === 'all' || platform === 'shipmaxx';
  const includeSr = platform === 'all' || platform === 'shiprocket';

  const [smxDelivered, srDelivered, lastSmxDelivered, lastSrDelivered, returningSmxDelivered] = await Promise.all([
    includeSmx ? ShipmaxxOrder.find(deliveredQuery)
      .select('_id order_id awb_code billing_customer_name billing_phone sub_total delivered_at createdAt status_updated_at support_staff lead_id source_order_id platform order_items')
      .populate('lead_id', 'department name phone')
      .lean() : Promise.resolve([]),
    includeSr ? ShiprocketOrder.find(deliveredQuery)
      .select('_id order_id awb_code billing_customer_name billing_phone sub_total delivered_at createdAt status_updated_at support_staff lead_id source_order_id platform order_items')
      .populate('lead_id', 'department name phone')
      .lean() : Promise.resolve([]),
    includeSmx ? ShipmaxxOrder.find(lastCohortQuery)
      .select('_id order_id awb_code billing_customer_name billing_phone sub_total delivered_at createdAt status_updated_at support_staff lead_id source_order_id platform order_items')
      .populate('lead_id', 'department name phone')
      .lean() : Promise.resolve([]),
    includeSr ? ShiprocketOrder.find(lastCohortQuery)
      .select('_id order_id awb_code billing_customer_name billing_phone sub_total delivered_at createdAt status_updated_at support_staff lead_id source_order_id platform order_items')
      .populate('lead_id', 'department name phone')
      .lean() : Promise.resolve([]),
    includeSmx ? ShipmaxxOrder.find(returningCohortQuery)
      .select('_id order_id billing_phone')
      .lean() : Promise.resolve([])
  ]);

  let allDelivered = [...smxDelivered, ...srDelivered];
  let allLastCohortDelivered = [...lastSmxDelivered, ...lastSrDelivered];

  // Apply department filter if specified
  if (department && department !== 'all') {
    allDelivered = allDelivered.filter(o => o.lead_id?.department === department);
    allLastCohortDelivered = allLastCohortDelivered.filter(o => o.lead_id?.department === department);
  }

  const totalDelivered = allDelivered.length;
  // Last month cohort base: Patients delivered in previous cycle whose medicines finish this cycle
  const lastMonthDeliveredBase = allLastCohortDelivered.length > 0 ? allLastCohortDelivered.length : totalDelivered;
  // This month's target is benchmark % of Last Month's Delivered Cohort!
  const targetReorders = Math.round(lastMonthDeliveredBase * (benchmarkRatePercent / 100));

  // Build set of previous cohort customer phones (September cohort)
  const previousCohortPhones = new Set(
    allLastCohortDelivered
      .map(o => String(o.billing_phone || '').replace(/\D/g, '').slice(-10))
      .filter(p => p.length === 10)
  );

  // Build set of all returning cohort customer phones (August + September returning patients)
  const returningCohortPhones = new Set(
    (returningSmxDelivered || [])
      .map(o => String(o.billing_phone || '').replace(/\D/g, '').slice(-10))
      .filter(p => p.length === 10)
  );

  // 4. Medicine Refill Radar (Calculated dynamically across active patient treatment continuum)
  const now = Date.now();
  const refillBuckets = {
    inProgress: [], // Days 1-15
    midCourse: [],  // Days 16-21
    refillDue: [],  // Days 22-26 (URGENT RE-ORDER WINDOW)
    gapRisk: []     // Days 27+ (Course gap risk)
  };

  // Combine this period's deliveries with last month's cohort deliveries to track all 30-day treatment courses
  const radarOrdersMap = new Map();
  [...allDelivered, ...allLastCohortDelivered].forEach(o => {
    radarOrdersMap.set(String(o._id), o);
  });
  const radarOrders = Array.from(radarOrdersMap.values());

  radarOrders.forEach(o => {
    const delDate = new Date(o.delivered_at || o.status_updated_at || o.createdAt);
    const diffDays = Math.max(0, Math.floor((now - delDate.getTime()) / (1000 * 60 * 60 * 24)));
    
    // Only include patients whose course delivery was in the active refill continuum (1 to 55 days)
    if (diffDays > 55) return;

    const patientItem = {
      _id: String(o._id),
      order_id: o.order_id || String(o._id),
      name: o.billing_customer_name || o.lead_id?.name || o.customer_name || o.shipping_customer_name || o.name || 'Patient',
      phone: o.billing_phone || o.lead_id?.phone || '—',
      delivered_at: delDate,
      days_elapsed: diffDays,
      department: o.lead_id?.department || 'general',
      amount: Number(o.sub_total) || 0,
      platform: o.platform || 'shipmaxx',
      productName: o.order_items?.[0]?.name || 'Ayurvedic Treatment Kit'
    };

    if (diffDays <= 15) {
      refillBuckets.inProgress.push(patientItem);
    } else if (diffDays <= 21) {
      refillBuckets.midCourse.push(patientItem);
    } else if (diffDays <= 26) {
      refillBuckets.refillDue.push(patientItem);
    } else {
      refillBuckets.gapRisk.push(patientItem);
    }
  });

  // Sort refillDue and gapRisk by days elapsed
  refillBuckets.refillDue.sort((a, b) => b.days_elapsed - a.days_elapsed);
  refillBuckets.gapRisk.sort((a, b) => b.days_elapsed - a.days_elapsed);

  // 5. Follow-Up Stage Distribution (Dynamic Funnel & Drilldowns)
  const deliveredOrderIds = allDelivered.map(o => String(o._id));
  const deliveredOrderCustomIds = allDelivered.map(o => String(o.order_id || o._id));

  const [smxFollowups, srFollowups] = await Promise.all([
    ShipmaxxFollowup.find({
      $or: [
        { order_id: { $in: deliveredOrderCustomIds } },
        { order_id: { $in: deliveredOrderIds } }
      ]
    }).lean(),
    ShiprocketFollowup.find({
      order_id: { $in: deliveredOrderIds }
    }).lean()
  ]);

  const allFollowups = [...smxFollowups, ...srFollowups];

  const funnelCounts = { fu1: 0, fu2: 0, fu3: 0, fu4: 0, fu5: 0, completedAll: 0 };
  const funnelLists = { fu1: [], fu2: [], fu3: [], fu4: [], fu5: [] };

  const orderFollowupMap = {};
  allFollowups.forEach(f => {
    const key = String(f.order_id);
    if (!orderFollowupMap[key]) orderFollowupMap[key] = [];
    orderFollowupMap[key].push(f);
  });

  allDelivered.forEach(o => {
    const key1 = String(o._id);
    const key2 = String(o.order_id || '');
    const fus = orderFollowupMap[key1] || orderFollowupMap[key2] || [];

    const pSummary = {
      _id: String(o._id),
      order_id: o.order_id || String(o._id),
      name: o.billing_customer_name || o.lead_id?.name || 'Customer',
      phone: o.billing_phone || o.lead_id?.phone || '—',
      department: o.lead_id?.department || 'general',
      amount: Number(o.sub_total) || 0,
      delivered_at: o.delivered_at || o.status_updated_at || o.createdAt,
      platform: o.platform || 'shipmaxx'
    };

    if (fus.length === 0) {
      funnelCounts.fu1++;
      funnelLists.fu1.push(pSummary);
      return;
    }

    const uncompleted = fus.filter(f => !f.completed).sort((a, b) => a.followup_number - b.followup_number);
    if (uncompleted.length > 0) {
      const activeStage = uncompleted[0].followup_number;
      if (activeStage === 1) { funnelCounts.fu1++; funnelLists.fu1.push(pSummary); }
      else if (activeStage === 2) { funnelCounts.fu2++; funnelLists.fu2.push(pSummary); }
      else if (activeStage === 3) { funnelCounts.fu3++; funnelLists.fu3.push(pSummary); }
      else if (activeStage === 4) { funnelCounts.fu4++; funnelLists.fu4.push(pSummary); }
      else if (activeStage === 5) { funnelCounts.fu5++; funnelLists.fu5.push(pSummary); }
    } else {
      funnelCounts.completedAll++;
    }
  });

  // 6. Patient Relief Health Meter (Comprehensive Multi-Source Calculation & Lists)
  let highReliefCount = 0;
  let moderateReliefCount = 0;
  let lowOrNoReliefCount = 0;
  let reliefRecordedCount = 0;
  let totalReliefSum = 0;

  const stageReliefSums = {
    1: { sum: 0, count: 0 },
    2: { sum: 0, count: 0 },
    3: { sum: 0, count: 0 },
    4: { sum: 0, count: 0 },
    5: { sum: 0, count: 0 }
  };
  const reliefLists = { high: [], moderate: [], low: [] };

  // Fetch all recorded clinical relief evaluations across collections:
  // 1) Shiprocket completed followups with recorded relief
  // 2) Shipmaxx followups with relief or clinical notes
  // 3) Doctor / Verification consultations with recorded relief
  const [srReliefFollowups, smxReliefFollowups, verReliefRecords] = await Promise.all([
    ShiprocketFollowup.find({ relief_percentage: { $ne: null, $gte: 0 } }).lean(),
    ShipmaxxFollowup.find({
      $or: [
        { relief_percentage: { $ne: null, $gte: 0 } },
        { notes: { $regex: /(aram|fayda|relief)/i } }
      ]
    }).lean(),
    Verification.find({ relief_percentage: { $ne: null, $gte: 0 } }).populate('lead', 'name phone department').lean()
  ]);

  // Map order details for SR followups
  const srReliefOrderIds = srReliefFollowups.map(f => f.order_id).filter(Boolean);
  const srReliefOrders = srReliefOrderIds.length > 0 ? await ShiprocketOrder.find({ _id: { $in: srReliefOrderIds } }).select('order_id billing_customer_name billing_phone lead_id department').lean() : [];
  const srReliefOrderMap = new Map(srReliefOrders.map(o => [String(o._id), o]));

  // Map order details for SMX followups
  const smxReliefOrderIds = smxReliefFollowups.map(f => f.order_id).filter(Boolean);
  const smxReliefOrders = smxReliefOrderIds.length > 0 ? await ShipmaxxOrder.find({
    $or: [
      { _id: { $in: smxReliefOrderIds.filter(id => id.match(/^[0-9a-f]{24}$/i)).map(id => new mongoose.Types.ObjectId(id)) } },
      { order_id: { $in: smxReliefOrderIds } }
    ]
  }).select('order_id billing_customer_name billing_phone lead_id').populate('lead_id', 'name phone department').lean() : [];
  const smxReliefOrderMap = new Map();
  smxReliefOrders.forEach(o => {
    smxReliefOrderMap.set(String(o._id), o);
    if (o.order_id) smxReliefOrderMap.set(String(o.order_id), o);
  });

  const pushReliefItem = (item) => {
    // If department filter is active, match department
    if (department && department !== 'all' && item.department !== department) return;

    reliefRecordedCount++;
    totalReliefSum += item.relief_percentage;

    const stage = Math.min(5, Math.max(1, item.followup_number || 1));
    if (stageReliefSums[stage]) {
      stageReliefSums[stage].sum += item.relief_percentage;
      stageReliefSums[stage].count++;
    }

    if (item.relief_percentage >= 70) {
      highReliefCount++;
      reliefLists.high.push(item);
    } else if (item.relief_percentage >= 40) {
      moderateReliefCount++;
      reliefLists.moderate.push(item);
    } else {
      lowOrNoReliefCount++;
      reliefLists.low.push(item);
    }
  };

  // Process SR Followups
  srReliefFollowups.forEach(f => {
    const o = srReliefOrderMap.get(String(f.order_id)) || {};
    pushReliefItem({
      order_id: o.order_id || String(f.order_id),
      name: o.billing_customer_name || 'Patient',
      phone: o.billing_phone || '—',
      department: o.department || 'migraine',
      followup_number: f.followup_number || 1,
      relief_percentage: Number(f.relief_percentage),
      notes: f.notes || f.note || 'Follow-up consultation relief recorded',
      date: f.completed_at || f.updatedAt || f.createdAt
    });
  });

  // Process SMX Followups
  smxReliefFollowups.forEach(f => {
    const o = smxReliefOrderMap.get(String(f.order_id)) || {};
    let val = f.relief_percentage;
    const note = (f.notes || '').toLowerCase();
    if (val === null || val === undefined) {
      if (note.includes('bilkul aram ni') || note.includes('aram nahi') || note.includes('no relief')) val = 15;
      else if (note.includes('phle se aram') || note.includes('dwa se aram') || note.includes('aram h')) val = 75;
      else if (note.includes('gas') || note.includes('kam')) val = 45;
      else val = 60;
    }
    pushReliefItem({
      order_id: o.order_id || String(f.order_id),
      name: o.billing_customer_name || o.lead_id?.name || 'Patient',
      phone: o.billing_phone || o.lead_id?.phone || '—',
      department: o.lead_id?.department || 'migraine',
      followup_number: f.followup_number || 1,
      relief_percentage: Number(val),
      notes: f.notes || 'Follow-up feedback recorded',
      date: f.completed_at || f.updatedAt || f.createdAt
    });
  });

  // Process Verification Relief Evaluations
  verReliefRecords.forEach(v => {
    const l = v.lead || {};
    pushReliefItem({
      order_id: v.order_id || String(v._id),
      name: l.name || v.title?.replace('Call ', '') || 'Patient',
      phone: l.phone || v.description?.match(/Phone:\s*(\d+)/)?.[1] || '—',
      department: v.department || l.department || 'migraine',
      followup_number: 1,
      relief_percentage: Number(v.relief_percentage),
      notes: v.problem || 'Doctor verification reported relief',
      date: v.updatedAt || v.createdAt
    });
  });

  const averageRelief = reliefRecordedCount > 0 ? Math.round(totalReliefSum / reliefRecordedCount) : 0;
  const stageAverageRelief = {
    fu1: stageReliefSums[1].count > 0 ? Math.round(stageReliefSums[1].sum / stageReliefSums[1].count) : 35,
    fu2: stageReliefSums[2].count > 0 ? Math.round(stageReliefSums[2].sum / stageReliefSums[2].count) : 48,
    fu3: stageReliefSums[3].count > 0 ? Math.round(stageReliefSums[3].sum / stageReliefSums[3].count) : 58,
    fu4: stageReliefSums[4].count > 0 ? Math.round(stageReliefSums[4].sum / stageReliefSums[4].count) : 72,
    fu5: stageReliefSums[5].count > 0 ? Math.round(stageReliefSums[5].sum / stageReliefSums[5].count) : 85,
  };

  // 7. End-to-End Re-Verification & Re-Order Tracking
  // Query all orders created in this period to identify repeat bookings
  const periodOrderFilter = {
    createdAt: { $gte: startDate, $lte: endDate },
    is_manual_bill: { $ne: true }
  };

  if (effectiveStaffId) {
    const sOid = new mongoose.Types.ObjectId(effectiveStaffId);
    periodOrderFilter.$and = [
      {
        $or: [
          { support_staff: sOid },
          { verified_by: sOid },
          { created_by: sOid },
          { task_created_by: sOid }
        ]
      }
    ];
  }

  const [periodSMX, periodSR, immutableCommissions] = await Promise.all([
    includeSmx ? ShipmaxxOrder.find(periodOrderFilter).select('_id order_id awb_code status sub_total billing_customer_name billing_phone createdAt delivered_at platform courier_name rto_verification_action courier_reason source_order_id order_items').lean() : Promise.resolve([]),
    includeSr ? ShiprocketOrder.find(periodOrderFilter).select('_id order_id awb_code status sub_total billing_customer_name billing_phone createdAt delivered_at platform courier_name rto_verification_action courier_reason source_order_id order_items').lean() : Promise.resolve([]),
    CommissionRecord.find({
      commission_role: 'reorder',
      entry_type: 'credit',
      ...(effectiveStaffId ? { staff_id: new mongoose.Types.ObjectId(effectiveStaffId) } : {}),
      createdAt: { $gte: startDate, $lte: endDate }
    }).lean()
  ]);

  const rawPeriodOrders = [...periodSMX, ...periodSR];

  // A repeat order in this period is identified by:
  // 1) Linked source_order_id
  // 2) SKU contains repeat/reorder/kit2/kit3
  // 3) Phone belongs to a patient delivered in previous cycles (August + September returning patients)
  const isRepeatOrder = (ro) => {
    if (ro.source_order_id) return true;
    const sku = ro.order_items?.[0]?.sku || '';
    if (/reorder|repeat|kit2|kit3/i.test(sku)) return true;
    const cleanPhone = String(ro.billing_phone || '').replace(/\D/g, '').slice(-10);
    if (cleanPhone && (returningCohortPhones.has(cleanPhone) || previousCohortPhones.has(cleanPhone))) return true;
    return false;
  };

  const allReorders = rawPeriodOrders.filter(isRepeatOrder);

  // Delivered repeats in this period (from allDelivered orders)
  const allDeliveredRepeats = allDelivered.filter(isRepeatOrder);
  const deliveredFromSepCohort = allDelivered.filter(o => {
    const cleanPhone = String(o.billing_phone || '').replace(/\D/g, '').slice(-10);
    return cleanPhone && previousCohortPhones.has(cleanPhone);
  });

  let reordersBooked = allReorders.length;
  let reordersVerified = 0;
  let reordersInTransit = 0;
  let reordersRto = 0;
  const reordersDelivered = allDeliveredRepeats.length;
  const reordersDeliveredFromCohort = deliveredFromSepCohort.length;
  const reordersDeliveredFromExtendedCohort = Math.max(0, reordersDelivered - reordersDeliveredFromCohort);
  const reordersRevenue = allDeliveredRepeats.reduce((sum, ro) => sum + (Number(ro.sub_total) || 0), 0);

  const reorderLists = {
    booked: [],
    inTransit: [],
    delivered: [],
    rto: []
  };

  allReorders.forEach(ro => {
    const st = (ro.status || '').toUpperCase();
    const cleanPhone = String(ro.billing_phone || '').replace(/\D/g, '').slice(-10);
    const isFromSep = cleanPhone && previousCohortPhones.has(cleanPhone);
    const isFromAug = !isFromSep && cleanPhone && returningCohortPhones.has(cleanPhone);

    const item = {
      _id: String(ro._id),
      order_id: ro.order_id,
      name: ro.billing_customer_name || 'Customer',
      phone: ro.billing_phone || '—',
      status: ro.status,
      amount: Number(ro.sub_total) || 0,
      awb: ro.awb_code || '—',
      courier: ro.courier_name || 'Courier',
      platform: ro.platform || 'shipmaxx',
      date: ro.delivered_at || ro.createdAt,
      isFromCohort: isFromSep || isFromAug,
      cohortBadge: isFromSep ? `${lastCohortMonthName} Cohort` : isFromAug ? `${returningCohortMonthName} Returning Patient` : 'Repeat Kit'
    };

    reorderLists.booked.push(item);

    if (st.includes('RTO')) {
      reordersRto++;
      reorderLists.rto.push(item);
    } else if (['SHIPPED', 'IN_TRANSIT', 'IN TRANSIT', 'OUT FOR DELIVERY', 'REACHED AT DESTINATION HUB'].some(s => st.includes(s))) {
      reordersInTransit++;
      reorderLists.inTransit.push(item);
    } else if (['VERIFIED', 'READY TO SHIP', 'READY_TO_SHIP', 'DISPATCH'].some(s => st.includes(s))) {
      reordersVerified++;
    }
  });

  // Populate delivered reorders list with rich cohort info
  allDeliveredRepeats.forEach(ro => {
    const cleanPhone = String(ro.billing_phone || '').replace(/\D/g, '').slice(-10);
    const isFromSep = cleanPhone && previousCohortPhones.has(cleanPhone);
    const isFromAug = !isFromSep && cleanPhone && returningCohortPhones.has(cleanPhone);

    reorderLists.delivered.push({
      _id: String(ro._id),
      order_id: ro.order_id,
      name: ro.billing_customer_name || 'Customer',
      phone: ro.billing_phone || '—',
      status: 'DELIVERED',
      amount: Number(ro.sub_total) || 0,
      awb: ro.awb_code || '—',
      courier: ro.courier_name || 'Courier',
      platform: ro.platform || 'shipmaxx',
      date: ro.delivered_at || ro.createdAt,
      isFromCohort: isFromSep || isFromAug,
      cohortBadge: isFromSep ? `${lastCohortMonthName} Cohort Refill` : isFromAug ? `${returningCohortMonthName} Returning Patient` : 'Repeat Kit'
    });
  });

  // Calculate Commission:
  // If immutable records exist in CommissionRecord ledger, use exact sum; else compute from delivered count * unit
  const immutableSum = immutableCommissions.reduce((sum, c) => sum + (Number(c.commission_amount) || 0), 0);
  const reorderCommissionUnit = reorderSettings.reorder_commission_amount || 150;
  const totalEarnedCommission = immutableSum > 0 ? immutableSum : (reordersDelivered * reorderCommissionUnit);
  const expectedInTransitCommission = reordersInTransit * reorderCommissionUnit;

  // 8. Re-Order NDR & Delivery Rescue Alerts
  const ndrRescueList = allReorders.filter(ro => {
    const st = (ro.status || '').toUpperCase();
    return st.includes('UNDELIVERED') || st.includes('EXCEPTION') || st.includes('ATTEMPT FAILURE') || (st.includes('RTO') && ro.rto_verification_action !== 'send_to_verification');
  }).map(ro => ({
    _id: String(ro._id),
    order_id: ro.order_id,
    awb: ro.awb_code || '—',
    name: ro.billing_customer_name || 'Customer',
    phone: ro.billing_phone || '—',
    courier: ro.courier_name || 'Courier',
    status: ro.status,
    reason: ro.courier_reason || 'Undelivered Attempt / Customer Unreachable',
    amount: ro.sub_total || 0,
    platform: ro.platform || 'shipmaxx'
  }));

  // 9. WhatsApp Patient Intent & Automated Keyword Replies
  const whatsappSentiment = {
    bookNextMonth: 0,
    talkDoctor: 0,
    dosageEnquiry: 0,
    reliefNegative: 0,
    reliefPositive: 0,
    callRequested: 0,
    lists: {
      bookNextMonth: [],
      talkDoctor: [],
      dosageEnquiry: [],
      reliefNegative: []
    }
  };

  // Fetch all orders with incoming WhatsApp keyword replies
  const replyOrders = await ShipmaxxOrder.find({
    interakt_reply_text: { $exists: true, $ne: null }
  })
    .select('order_id billing_customer_name billing_phone interakt_reply_text interakt_reply_at delivered_at createdAt lead_id')
    .populate('lead_id', 'department name phone')
    .sort({ interakt_reply_at: -1, createdAt: -1 })
    .lean();

  replyOrders.forEach(o => {
    const text = (o.interakt_reply_text || '').toLowerCase().trim();
    if (!text) return;
    if (department && department !== 'all' && o.lead_id?.department && o.lead_id.department !== department) return;

    const item = {
      _id: String(o._id),
      order_id: o.order_id,
      name: o.billing_customer_name || o.lead_id?.name || 'Patient',
      phone: o.billing_phone || o.lead_id?.phone || '—',
      notes: o.interakt_reply_text,
      date: o.interakt_reply_at || o.delivered_at || o.createdAt,
      status: 'WhatsApp Reply Received'
    };

    if (
      text.includes('अगले महीने') || text.includes('agle mahine') || text.includes('next kit') ||
      text.includes('book') || text.includes('bhej do') || text.includes('dawai bhej') ||
      text.includes('order by friend') || text.includes('2 kit') || text.includes('3 kit') ||
      text.includes('taiyar') || text.includes('ready')
    ) {
      whatsappSentiment.bookNextMonth++;
      whatsappSentiment.lists.bookNextMonth.push(item);
    } else if (
      text.includes('डॉक्टर') || text.includes('doctor') || text.includes('d.r') ||
      text.includes('dr ') || text.includes('appointment') || text.includes('बात करनी') || text.includes('baat karni')
    ) {
      whatsappSentiment.talkDoctor++;
      whatsappSentiment.lists.talkDoctor.push(item);
    } else if (
      text.includes('kaise le') || text.includes('kaise khana') || text.includes('kaise khaye') ||
      text.includes('sevan') || text.includes('how to use') || text.includes('goli') ||
      text.includes('capsule') || text.includes('tarika') || text.includes('khashe') || text.includes('kaise')
    ) {
      whatsappSentiment.dosageEnquiry++;
      whatsappSentiment.lists.dosageEnquiry.push(item);
    } else if (
      text.includes('aram nahi') || text.includes('aaram nahi') || text.includes('aram nhi') ||
      text.includes('kam aaram') || text.includes('kam aram') || text.includes('dard kam nahi') ||
      text.includes('fark nahi') || text.includes('koi fark') || text.includes('koi aaram') ||
      text.includes('fayda nahi') || text.includes('dard ho raha') || text.includes('bilkul') ||
      text.includes('bahut jyada') || text.includes('dikkt') || text.includes('dikkat') || text.includes('nhi mila')
    ) {
      whatsappSentiment.reliefNegative++;
      whatsappSentiment.lists.reliefNegative.push(item);
    } else if (text.includes('aaram mil raha') || text.includes('aram mil raha') || text.includes('aram h') || text.includes('ha mil raha') || text.includes('aaram')) {
      whatsappSentiment.reliefPositive++;
    } else if (text.includes('call') || text.includes('coll') || text.includes('cl me') || text.includes('phone karo') || text.includes('कॉल')) {
      whatsappSentiment.callRequested++;
    }
  });

  // 10. Department Breakdown
  const migraineDelivered = allDelivered.filter(o => o.lead_id?.department === 'migraine').length;
  const pilesDelivered = allDelivered.filter(o => o.lead_id?.department === 'piles').length;

  // 11. Daily Target & Verification Metrics for Support Staff
  const todayDateStr = nowIst.toISOString().slice(0, 10);
  const isSupervisionAll = !isSupportOnly && !effectiveStaffId;

  const todayStart = new Date(Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth(), nowIst.getUTCDate()) - IST_OFFSET);
  const todayEnd = new Date(todayStart.getTime() + 86400000 - 1);
  const monthStart = new Date(Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth(), 1) - IST_OFFSET);

  let targetDoc = null;
  let dTarget = 0;
  let todayVerifCount = 0;
  let monthVerifCount = 0;
  let pendingTasksCount = 0;
  let todayLeadsCount = 0;

  if (isSupervisionAll) {
    const supportIds = (allSupportStaff || []).map(s => s._id);
    const [targets, tCount, mCount, pTasks, tLeads] = await Promise.all([
      StaffTarget.find({ user: { $in: supportIds }, date: todayDateStr }).lean(),
      Verification.countDocuments({ isDeleted: false, createdAt: { $gte: todayStart, $lte: todayEnd } }),
      Verification.countDocuments({ isDeleted: false, createdAt: { $gte: monthStart, $lte: todayEnd } }),
      Task.countDocuments({ status: 'pending', isDeleted: false }),
      Lead.countDocuments({ isDeleted: false, createdAt: { $gte: todayStart, $lte: todayEnd } })
    ]);

    dTarget = (targets || []).reduce((sum, t) => sum + (t.target || 0), 0);
    todayVerifCount = tCount;
    monthVerifCount = mCount;
    pendingTasksCount = pTasks;
    todayLeadsCount = tLeads;
  } else {
    const targetStaffId = effectiveStaffId || (user?._id ? String(user._id) : (user?.id ? String(user.id) : null));
    const targetStaffOid = targetStaffId && mongoose.isValidObjectId(targetStaffId) ? new mongoose.Types.ObjectId(targetStaffId) : null;

    if (targetStaffOid) {
      const verifStaffQuery = {
        $or: [
          { assignedTo: targetStaffOid },
          { verifiedBy: targetStaffOid },
          { createdBy: targetStaffOid }
        ],
        isDeleted: false
      };

      const taskStaffQuery = {
        $or: [
          { assignedTo: targetStaffOid },
          { createdBy: targetStaffOid }
        ],
        status: 'pending',
        isDeleted: false
      };

      const leadStaffQuery = {
        $or: [
          { assignedTo: targetStaffOid },
          { createdBy: targetStaffOid }
        ],
        isDeleted: false
      };

      const [tDoc, tCount, mCount, pTasks, tLeads] = await Promise.all([
        StaffTarget.findOne({ user: targetStaffOid, date: todayDateStr }).lean(),
        Verification.countDocuments({ ...verifStaffQuery, createdAt: { $gte: todayStart, $lte: todayEnd } }),
        Verification.countDocuments({ ...verifStaffQuery, createdAt: { $gte: monthStart, $lte: todayEnd } }),
        Task.countDocuments(taskStaffQuery),
        Lead.countDocuments({ ...leadStaffQuery, createdAt: { $gte: todayStart, $lte: todayEnd } })
      ]);

      targetDoc = tDoc;
      dTarget = targetDoc?.target || 0;
      todayVerifCount = tCount;
      monthVerifCount = mCount;
      pendingTasksCount = pTasks;
      todayLeadsCount = tLeads;
    }
  }

  const dDone = todayVerifCount;
  const dRemaining = dTarget > 0 ? Math.max(0, dTarget - dDone) : 0;
  const dProgressPct = dTarget > 0 ? Math.min(100, Math.round((dDone / dTarget) * 100)) : 0;

  const dailyTarget = {
    target: dTarget,
    done: dDone,
    remaining: dRemaining,
    progressPct: dProgressPct,
    monthVerifications: monthVerifCount,
    pendingTasks: pendingTasksCount,
    todayLeads: todayLeadsCount,
    date: todayDateStr,
    isSupervision: isSupervisionAll
  };

  return {
    period: {
      from: startDate.toISOString(),
      to: endDate.toISOString(),
      month,
      year,
      preset: preset || 'month',
      department: department || 'all',
      staffId: effectiveStaffId || 'all',
      targetRate: benchmarkRatePercent
    },
    // Dynamic Meta: Active Doctors & Support Staff for UI Dropdowns
    meta: {
      departments: (distinctDepts || []).filter(Boolean),
      doctors: activeDoctors.map(d => ({
        id: String(d._id),
        name: d.name,
        specialization: d.specialization || 'Ayurvedic Consultant',
        phone: d.phone
      })),
      supportStaff: allSupportStaff.map(s => ({
        id: String(s._id),
        name: s.name,
        phone: s.phone
      }))
    },
    dailyTarget,
    // Top Hero KPIs & Cohort Target Breakdown
    summary: {
      currentMonthName,
      lastCohortMonthName,
      returningCohortMonthName,
      lastCohortMonthShort,
      returningCohortMonthShort,
      totalDelivered, // Delivered in this selected period (Forms next cycle's target base!)
      thisMonthDelivered: totalDelivered,
      lastMonthDeliveredBase, // Last Month Delivered Base (The patient cohort whose kits finish this month)
      lastMonthUniquePatients: previousCohortPhones.size,
      targetReorders, // Benchmark target kits to re-order this month
      reorderTargetRatePercent: benchmarkRatePercent,
      reordersBooked,
      reordersDelivered, // Total repeat deliveries achieved this month (August + September returning patients)
      reordersDeliveredFromCohort, // Repeat kits delivered directly to last month's (September) cohort patients
      reordersDeliveredFromExtendedCohort, // Repeat kits delivered to August returning patients
      reordersInTransit,
      reordersRto,
      reordersRevenue,
      totalEarnedCommission,
      expectedInTransitCommission,
      targetAchievementPercent: targetReorders > 0 ? Math.round((reordersDelivered / targetReorders) * 100) : 0,
      cohortRetentionRatePercent: lastMonthDeliveredBase > 0 ? Math.round((reordersDeliveredFromCohort / lastMonthDeliveredBase) * 100) : 0,
      reorderConversionPercent: totalDelivered > 0 ? Math.round((reordersDelivered / totalDelivered) * 100) : 0,
      gapToTarget: Math.max(0, targetReorders - reordersDelivered)
    },
    // Dynamic Funnel & Drilldowns
    funnel: {
      counts: funnelCounts,
      lists: {
        fu1: funnelLists.fu1.slice(0, 30),
        fu2: funnelLists.fu2.slice(0, 30),
        fu3: funnelLists.fu3.slice(0, 30),
        fu4: funnelLists.fu4.slice(0, 30),
        fu5: funnelLists.fu5.slice(0, 30)
      }
    },
    // Dynamic Relief Meter & Lists
    reliefMeter: {
      averageRelief,
      highReliefCount,
      moderateReliefCount,
      lowOrNoReliefCount,
      reliefRecordedCount,
      stageAverageRelief,
      lists: {
        high: reliefLists.high.slice(0, 30),
        moderate: reliefLists.moderate.slice(0, 30),
        low: reliefLists.low.slice(0, 30)
      }
    },
    // Medicine Refill Radar
    refillRadar: {
      inProgressCount: refillBuckets.inProgress.length,
      midCourseCount: refillBuckets.midCourse.length,
      refillDueCount: refillBuckets.refillDue.length,
      gapRiskCount: refillBuckets.gapRisk.length,
      refillDueList: refillBuckets.refillDue.slice(0, 40),
      gapRiskList: refillBuckets.gapRisk.slice(0, 40)
    },
    // Reorder Lists
    reorderLists: {
      booked: reorderLists.booked.slice(0, 30),
      inTransit: reorderLists.inTransit.slice(0, 30),
      delivered: reorderLists.delivered.slice(0, 30),
      rto: reorderLists.rto.slice(0, 30)
    },
    // Reorder NDR Delivery Rescue
    ndrRescue: {
      count: ndrRescueList.length,
      orders: ndrRescueList.slice(0, 30)
    },
    // WhatsApp Sentiment
    whatsappSentiment,
    // Department Breakdown
    departmentStats: {
      migraineDelivered,
      pilesDelivered
    }
  };
};

export default {
  getSupportDashboardStats
};

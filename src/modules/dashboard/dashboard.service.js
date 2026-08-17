import Lead from '../lead/lead.model.js';
import Task from '../task/task.model.js';
import { Order } from '../shiprocket/models/order.model.js';
import Verification from '../verification/verification.model.js';
import { ShipmaxxOrder } from '../shipmaxx/models/shipmaxxOrder.model.js';
import StaffTarget from './staffTarget.model.js';
import Cnp from '../cnp/cnp.model.js';
import CallAgain from '../callagain/callagain.model.js';
import ReorderCommission from '../commission/reorderCommission.model.js';
import mongoose from 'mongoose';

const todayDateStr = () => new Date().toISOString().slice(0, 10);
const SUB_TOTAL_AMOUNT = { $convert: { input: '$sub_total', to: 'double', onError: 0, onNull: 0 } };

export const getStaffStats = async (userId, targetDate, from, to, userDepartments = []) => {
  const IST_OFFSET = 5.5 * 60 * 60 * 1000;
  let start, end;
  const target = targetDate ? new Date(targetDate) : new Date();

  const isAllTime = from === 'all' || to === 'all';
  if (isAllTime) {
    start = new Date(Date.UTC(target.getFullYear(), target.getMonth(), target.getDate()) - IST_OFFSET);
    end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
  } else if (from && to) {
    start = new Date(`${from}T00:00:00.000+05:30`);
    end = new Date(`${to}T23:59:59.999+05:30`);
  } else {
    start = new Date(Date.UTC(target.getFullYear(), target.getMonth(), target.getDate()) - IST_OFFSET);
    end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
  }
  
  const monthStart = new Date(Date.UTC(target.getFullYear(), target.getMonth(), 1) - IST_OFFSET);
  const uid = new mongoose.Types.ObjectId(userId);
  const dateStr = target.toISOString().slice(0, 10);

  const filter = { assignedTo: uid };
  if (userDepartments && userDepartments.length > 0) {
    filter.department = { $in: userDepartments };
  }

  const dateFilter = isAllTime ? {} : { createdAt: { $gte: start, $lte: end } };
  const updateDateFilter = isAllTime ? {} : { updatedAt: { $gte: start, $lte: end } };
  const monthDateFilter = isAllTime ? {} : { createdAt: { $gte: monthStart, $lte: end } };

  const [
    monthVerifications, 
    pendingTasks, 
    targetDoc,
    todayCnp, 
    todayCallAgain, 
    todayInterested, 
    todayNotInterested,
    leadsAdded,
    verifiedCount,
    onHoldCount,
    todayClosedLost,
    todayVerifications
  ] = await Promise.all([
    Verification.countDocuments({ ...filter, ...monthDateFilter }),
    Task.countDocuments({ ...filter, status: 'pending', isDeleted: false }),
    StaffTarget.findOne({ user: uid, date: dateStr }),
    Cnp.countDocuments({ ...filter, ...updateDateFilter }),
    CallAgain.countDocuments({ ...filter, ...updateDateFilter }),
    Task.countDocuments({ ...filter, status: 'interested', isDeleted: false, ...updateDateFilter }),
    Task.countDocuments({ ...filter, status: 'cancel_call', isDeleted: false, ...updateDateFilter }),
    Lead.countDocuments({ ...filter, ...dateFilter }),
    Verification.countDocuments({ ...filter, status: 'verified', isDeleted: false, ...updateDateFilter }),
    Verification.countDocuments({ ...filter, status: 'on_hold', ...updateDateFilter }),
    Lead.countDocuments({ ...filter, status: 'closed_lost', ...updateDateFilter }),
    Verification.countDocuments({ ...filter, ...dateFilter }),
  ]);

  const { Order } = await import('../shiprocket/models/order.model.js');
  const { ShipmaxxOrder } = await import('../shipmaxx/models/shipmaxxOrder.model.js');
  
  const userLeads = await Lead.find({ assignedTo: uid }).select('_id').lean();
  const leadIds = userLeads.map(l => l._id);

  const deliveredQuery = {
    status: { $regex: /^delivered$/i },
    ...(isAllTime ? {} : { $or: [{ delivered_at: { $gte: start, $lte: end } }, { updatedAt: { $gte: start, $lte: end } }] })
  };

  const [ordersSR, ordersSM] = await Promise.all([
    Order.find(deliveredQuery).select('source_order_id lead_id task_created_by verified_by created_by delivered_at updatedAt').lean(),
    ShipmaxxOrder.find(deliveredQuery).select('source_order_id lead_id task_created_by verified_by created_by delivered_at updatedAt').lean()
  ]);

  let newDeliveredCount = 0, salesOldDeliveredCount = 0, supportOldDeliveredCount = 0;
  const leadIdSet = new Set(leadIds.map(String));

  const processUserOrder = (o) => {
    const isOld = Boolean(o.source_order_id);
    const lId = o.lead_id ? String(o.lead_id) : null;
    const tId = o.task_created_by ? String(o.task_created_by) : null;
    const vId = o.verified_by ? String(o.verified_by) : null;
    const cId = o.created_by ? String(o.created_by) : null;

    if (!isOld) {
      if ((lId && leadIdSet.has(lId)) || (!lId && cId === String(uid)) || (tId === String(uid))) {
        newDeliveredCount++;
      }
    } else {
      if (lId && leadIdSet.has(lId)) {
        salesOldDeliveredCount++;
      }
      if (vId === String(uid) || (!vId && cId === String(uid))) {
        supportOldDeliveredCount++;
      }
    }
  };

  ordersSR.forEach(processUserOrder);
  ordersSM.forEach(processUserOrder);

  return {
    todayVerifications,
    monthVerifications,
    pendingTasks,
    todayTarget: targetDoc?.target || 0,
    todayCnp,
    todayCallAgain,
    todayInterested,
    todayNotInterested,
    todayClosedLost,
    leadsAdded,
    verifiedCount,
    onHoldCount,
    date: dateStr,
    newDeliveredCount,
    salesOldDeliveredCount,
    supportOldDeliveredCount
  };
};

export const setStaffTarget = async (userId, target, date) => {
  const targetDate = date || todayDateStr();
  let doc = await StaffTarget.findOne({ user: userId, date: targetDate });
  if (doc) {
    if (Number(target) < doc.target) {
      const ApiError = (await import('../../utils/ApiError.js')).default;
      throw new ApiError(400, 'You cannot decrease your target once set. You can only increase it.');
    }
    
    if (Number(target) > doc.target) {
      const IST_OFFSET = 5.5 * 60 * 60 * 1000;
      const tDate = new Date(targetDate);
      const startOfDay = new Date(Date.UTC(tDate.getFullYear(), tDate.getMonth(), tDate.getDate()) - IST_OFFSET);
      const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000 - 1);
      
      const Verification = (await import('../verification/verification.model.js')).default;
      const completedCount = await Verification.countDocuments({
        assignedTo: userId,
        createdAt: { $gte: startOfDay, $lte: endOfDay }
      });
      
      if (completedCount < doc.target) {
        const ApiError = (await import('../../utils/ApiError.js')).default;
        throw new ApiError(400, `You cannot increase your target until you achieve your current target of ${doc.target}. (Currently achieved: ${completedCount})`);
      }
    }

    doc.target = Number(target);
    await doc.save();
  } else {
    doc = await StaffTarget.create({ user: userId, date: targetDate, target: Number(target) });
  }
  return { todayTarget: doc.target, date: targetDate };
};

export const getTargetHistory = async (userId, month, year, days) => {
  const IST_OFFSET = 5.5 * 60 * 60 * 1000;
  const uid = new mongoose.Types.ObjectId(userId);
  const now = new Date();
  
  let startDateStr, endDateStr, periodStart, periodEnd;
  const dateList = [];

  if (days) {
    const numDays = Number(days);
    for (let i = 0; i < numDays; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      dateList.push({
        dateStr: d.toISOString().slice(0, 10),
        start: new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - IST_OFFSET),
        end: new Date(new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - IST_OFFSET).getTime() + 24 * 60 * 60 * 1000 - 1)
      });
    }
    startDateStr = dateList[dateList.length - 1].dateStr;
    endDateStr = dateList[0].dateStr;
    periodStart = dateList[dateList.length - 1].start;
    periodEnd = dateList[0].end;
  } else {
    const m = month !== undefined ? Number(month) : now.getMonth();
    const y = year !== undefined ? Number(year) : now.getFullYear();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    periodStart = new Date(Date.UTC(y, m, 1) - IST_OFFSET);
    periodEnd = new Date(Date.UTC(y, m + 1, 0, 23, 59, 59, 999) - IST_OFFSET);
    startDateStr = `${y}-${String(m + 1).padStart(2, '0')}-01`;
    endDateStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;
    
    const isCurrentMonth = m === now.getMonth() && y === now.getFullYear();
    const maxDay = isCurrentMonth ? now.getDate() : daysInMonth;
    
    for (let day = maxDay; day >= 1; day--) {
      dateList.push({
        dateStr: `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
      });
    }
  }

  const [targets, verifications, actualVerified] = await Promise.all([
    StaffTarget.find({ user: uid, date: { $gte: startDateStr, $lte: endDateStr } }).lean(),
    Verification.aggregate([
      { $match: { assignedTo: uid, createdAt: { $gte: periodStart, $lte: periodEnd } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: '+05:30' } }, count: { $sum: 1 } } }
    ]),
    Verification.aggregate([
      { $match: { assignedTo: uid, status: 'verified', updatedAt: { $gte: periodStart, $lte: periodEnd } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$updatedAt', timezone: '+05:30' } }, count: { $sum: 1 } } }
    ])
  ]);

  const targetMap = {};
  targets.forEach(t => { targetMap[t.date] = t.target; });
  const verifiedMap = {};
  verifications.forEach(v => { verifiedMap[v._id] = v.count; });
  const actualVerifiedMap = {};
  actualVerified.forEach(v => { actualVerifiedMap[v._id] = v.count; });

  return dateList.map(item => {
    const tgt = targetMap[item.dateStr] || 0;
    const done = verifiedMap[item.dateStr] || 0;
    return {
      date: item.dateStr,
      target: tgt,
      completed: done,
      verified: actualVerifiedMap[item.dateStr] || 0,
      achieved: tgt > 0 ? done >= tgt : false,
    };
  });
};

export const getStaffTodayLists = async (userRole, userId, targetDate, targetStaffId, from, to, userDepartments = []) => {
  const IST_OFFSET = 5.5 * 60 * 60 * 1000;
  let start, end;

  const isAllTime = from === 'all' || to === 'all';
  if (isAllTime) {
    const target = targetDate ? new Date(targetDate) : new Date();
    start = new Date(Date.UTC(target.getFullYear(), target.getMonth(), target.getDate()) - IST_OFFSET);
    end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
  } else if (from && to) {
    start = new Date(`${from}T00:00:00.000+05:30`);
    end = new Date(`${to}T23:59:59.999+05:30`);
  } else {
    const target = targetDate ? new Date(targetDate) : new Date();
    start = new Date(Date.UTC(target.getFullYear(), target.getMonth(), target.getDate()) - IST_OFFSET);
    end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
  }

  const filter = isAllTime ? {} : { createdAt: { $gte: start, $lte: end } };
  const updateFilter = isAllTime ? {} : { updatedAt: { $gte: start, $lte: end } };
  const taskFilter = { isDeleted: false, ...(isAllTime ? {} : { updatedAt: { $gte: start, $lte: end } }) };

  let sid = null;
  if (userRole === 'manager' || userRole === 'admin') {
    if (targetStaffId) sid = new mongoose.Types.ObjectId(targetStaffId);
  } else if (userRole === 'sales') {
    sid = new mongoose.Types.ObjectId(userId);
  }

  if (sid) {
    filter.assignedTo = sid;
    updateFilter.assignedTo = sid;
    taskFilter.assignedTo = sid;
  }
  
  if (userDepartments && userDepartments.length > 0) {
    filter.department = { $in: userDepartments };
    updateFilter.department = { $in: userDepartments };
    taskFilter.department = { $in: userDepartments };
  }

  // Build base filters (assignedTo + department only, no date) for queue-type statuses
  const baseFilter = {};
  if (sid) baseFilter.assignedTo = sid;
  if (userDepartments && userDepartments.length > 0) baseFilter.department = { $in: userDepartments };

  const [cnpList, callAgainList, interestedList, notInterestedList, onHoldList, verificationList] = await Promise.all([
    Cnp.find(updateFilter)
      .populate('lead', 'name phone').populate('assignedTo', 'name').sort({ updatedAt: -1 }).limit(100).lean(),
    CallAgain.find(updateFilter)
      .populate('lead', 'name phone').populate('assignedTo', 'name').sort({ updatedAt: -1 }).limit(100).lean(),
    // Interested & Not Interested: date-filtered by updatedAt — shows leads marked interested in selected period
    Task.find({ ...taskFilter, status: 'interested' })
      .populate('lead', 'name phone').sort({ updatedAt: -1 }).limit(100).lean(),
    Task.find({ ...taskFilter, status: 'cancel_call' })
      .populate('lead', 'name phone').sort({ updatedAt: -1 }).limit(100).lean(),
    // On Hold: date-filtered — verifications put on hold within selected period
    Verification.find({ ...updateFilter, status: 'on_hold' })
      .populate('lead', 'name phone').sort({ updatedAt: -1 }).limit(100).lean(),
    Verification.find({ ...filter })
      .populate('lead', 'name phone status').sort({ createdAt: -1 }).limit(100).lean(),
  ]);

  return { cnpList, callAgainList, interestedList, notInterestedList, onHoldList, verificationList };
};

export const getStaffMonthlyChart = async (userId) => {
  const IST_OFFSET = 5.5 * 60 * 60 * 1000;
  const nowIST = new Date(Date.now() + IST_OFFSET);
  const monthStart = new Date(Date.UTC(nowIST.getUTCFullYear(), nowIST.getUTCMonth(), 1) - IST_OFFSET);

  const match = { createdAt: { $gte: monthStart } };
  if (userId) {
    match.assignedTo = new mongoose.Types.ObjectId(userId);
  }

  const data = await Verification.aggregate([
    { $match: match },
    { $group: { _id: { $dayOfMonth: '$createdAt' }, count: { $sum: 1 } } },
    { $sort: { '_id': 1 } },
  ]);

  const daysInMonth = new Date(nowIST.getUTCFullYear(), nowIST.getUTCMonth() + 1, 0).getDate();
  return Array.from({ length: daysInMonth }, (_, i) => {
    const day = i + 1;
    const found = data.find(d => d._id === day);
    return { day, count: found?.count || 0 };
  });
};

export const getStaffVerifications = async (userId) => {
  const IST_OFFSET = 5.5 * 60 * 60 * 1000;
  const nowIST = new Date(Date.now() + IST_OFFSET);
  const todayStart = new Date(Date.UTC(nowIST.getUTCFullYear(), nowIST.getUTCMonth(), nowIST.getUTCDate()) - IST_OFFSET);
  const uid = new mongoose.Types.ObjectId(userId);

  return Verification.find({ assignedTo: uid, createdAt: { $gte: todayStart } })
    .populate('lead', 'name phone status')
    .sort({ createdAt: -1 })
    .lean();
};

function buildStatsDateRange(preset, fromDate, toDate) {
  const IST_OFFSET = 5.5 * 60 * 60 * 1000;
  const now = new Date();
  const istNow = new Date(now.getTime() + IST_OFFSET);
  const y = istNow.getUTCFullYear();
  const m = istNow.getUTCMonth();

  const isAll = preset === 'all' || fromDate === 'all' || toDate === 'all';
  if (isAll) {
    return { isAllTime: true, start: null, end: null };
  }
  if (preset === 'month' || preset === 'mtd' || fromDate === 'month') {
    const start = new Date(Date.UTC(y, m, 1) - IST_OFFSET);
    return { isAllTime: false, start: start, end: now };
  }
  if (preset === 'today' || fromDate === 'today') {
    const todayStr = istNow.toISOString().slice(0, 10);
    const start = new Date(`${todayStr}T00:00:00.000+05:30`);
    const end = new Date(`${todayStr}T23:59:59.999+05:30`);
    return { isAllTime: false, start: start, end: end };
  }
  if (preset === 'yesterday' || fromDate === 'yesterday') {
    const yesterdayIst = new Date(istNow.getTime() - 24 * 60 * 60 * 1000);
    const yesterdayStr = yesterdayIst.toISOString().slice(0, 10);
    const start = new Date(`${yesterdayStr}T00:00:00.000+05:30`);
    const end = new Date(`${yesterdayStr}T23:59:59.999+05:30`);
    return { isAllTime: false, start: start, end: end };
  }
  if (fromDate && toDate && fromDate !== 'undefined' && toDate !== 'undefined') {
    const start = new Date(`${fromDate}T00:00:00.000+05:30`);
    const end = new Date(`${toDate}T23:59:59.999+05:30`);
    return { isAllTime: false, start: start, end: end };
  }
  const todayStr = istNow.toISOString().slice(0, 10);
  const start = new Date(`${todayStr}T00:00:00.000+05:30`);
  const end = new Date(`${todayStr}T23:59:59.999+05:30`);
  return { isAllTime: false, start: start, end: end };
}

export const getAllStaffStats = async (targetDate, fromDate, toDate, preset, requestingUser) => {
  const IST_OFFSET = 5.5 * 60 * 60 * 1000;
  const { isAllTime, start: startOfDay, end: endOfDay } = buildStatsDateRange(preset, fromDate, toDate);
  let target = targetDate ? new Date(targetDate) : new Date();
  if (isNaN(target.getTime())) target = new Date();

  const monthStart = new Date(Date.UTC(target.getFullYear(), target.getMonth(), 1) - IST_OFFSET);
  const monthEnd = new Date(Date.UTC(target.getFullYear(), target.getMonth() + 1, 0, 23, 59, 59, 999) - IST_OFFSET);
  const dateStr = target.toISOString().slice(0, 10);

  const User = (await import('../user/user.model.js')).default;
  const Appointment = (await import('../appointment/appointment.model.js')).default;
  const Attendance = (await import('../attendance/attendance.model.js')).default;
  const Lead = (await import('../lead/lead.model.js')).default;
  const Verification = (await import('../verification/verification.model.js')).default;
  const Task = (await import('../task/task.model.js')).default;
  const StaffTarget = (await import('./staffTarget.model.js')).default;
  const Cnp = (await import('../cnp/cnp.model.js')).default;
  const CallAgain = (await import('../callagain/callagain.model.js')).default;
  const { Order } = await import('../shiprocket/models/order.model.js');
  const { ShipmaxxOrder } = await import('../shipmaxx/models/shipmaxxOrder.model.js');
  const ReorderCommission = (await import('../commission/reorderCommission.model.js')).default;

  const userQuery = { role: { $in: ['sales', 'manager', 'doctor', 'support', 'logistics'] }, isDeleted: false };
  if (requestingUser && ['sales', 'support', 'logistics'].includes(requestingUser.role)) {
    userQuery._id = requestingUser._id;
  }
  const allUsers = await User.find(userQuery).select('_id name phone role').lean();
  
  const statsMap = {};
  for (const u of allUsers) {
    statsMap[String(u._id)] = {
      user: u,
      todayVerifications: 0, monthVerifications: 0, pendingTasks: 0, todayTarget: 0,
      todayCnp: 0, todayCallAgain: 0, todayInterested: 0, todayNotInterested: 0, todayClosedLost: 0,
      leadsAdded: 0, tasksAssigned: 0, verifiedCount: 0, onHoldCount: 0, readyToShipmentCount: 0, deliveredCount: 0,
      rtoCount: 0, monthDispatchedCount: 0, monthDeliveredCount: 0, monthRtoCount: 0,
      assignedVerifications: 0, workingHours: 0, workingPercentage: 0,
      totalAppointments: 0, completedAppointments: 0, cancelledAppointments: 0,
      newDeliveredCount: 0, salesOldDeliveredCount: 0, supportOldDeliveredCount: 0,
      uniqueDeliveredCount: 0, // Counts each physical order exactly once (no dual-attribution inflation)
      commentsCount: 0, cnpComments: 0, callAgainComments: 0, interestedComments: 0,
      commission: 0,
      _noteSet: new Set(), _intSet: new Set(), _cnpSet: new Set(), _caSet: new Set()
    };
  }
  let totalUniqueDelivered = 0; // Grand total of unique delivered orders across all staff

  const queryMinStart = isAllTime ? null : (startOfDay < monthStart ? startOfDay : monthStart);
  const queryMaxEnd = isAllTime ? null : (endOfDay > monthEnd ? endOfDay : monthEnd);

  // 2. Fetch Bulk Data in parallel
  const [
    allAttendances, allAppointments, allTargets, allVerifications, allTasks, 
    allCnps, allCallAgains, allLeadsData, allOrdersSR, allOrdersSM, allCommissions
  ] = await Promise.all([
    Attendance.find({ date: { $gte: startOfDay, $lte: endOfDay }, isDeleted: false }).select('user checkIn checkOut workingHours').lean(),
    Appointment.find({ appointmentDate: { $gte: startOfDay, $lte: endOfDay }, isDeleted: false }).select('doctorName status').lean(),
    StaffTarget.find({ date: { $gte: fromDate || dateStr, $lte: toDate || dateStr } }).lean(),
    Verification.find({ isDeleted: { $ne: true }, ...(isAllTime ? {} : { createdAt: { $gte: queryMinStart, $lte: queryMaxEnd } }) }).select('assignedTo verifiedBy status createdAt updatedAt').lean(),
    Task.find({ 
      isDeleted: false, 
      ...(isAllTime ? {} : {
        $or: [
          { status: 'pending' }, 
          { createdAt: { $gte: startOfDay, $lte: endOfDay } },
          { updatedAt: { $gte: startOfDay, $lte: endOfDay } },
          { 'notes.createdAt': { $gte: startOfDay, $lte: endOfDay } }
        ]
      })
    }).select('lead assignedTo status notes updatedAt createdAt').lean(),
    Cnp.find({ ...(isAllTime ? {} : { $or: [{ updatedAt: { $gte: startOfDay, $lte: endOfDay } }, { 'notes.createdAt': { $gte: startOfDay, $lte: endOfDay } }] }) }).select('assignedTo notes updatedAt').lean(),
    CallAgain.find({ ...(isAllTime ? {} : { $or: [{ updatedAt: { $gte: startOfDay, $lte: endOfDay } }, { 'notes.createdAt': { $gte: startOfDay, $lte: endOfDay } }] }) }).select('lead assignedTo status notes updatedAt').lean(),
    Lead.find({ ...(isAllTime ? {} : { $or: [{ createdAt: { $gte: startOfDay, $lte: endOfDay } }, { updatedAt: { $gte: startOfDay, $lte: endOfDay } }, { 'notes.createdAt': { $gte: startOfDay, $lte: endOfDay } }, { 'follow_ups.date': { $gte: startOfDay, $lte: endOfDay } }] }) }).select('assignedTo status cnp notes follow_ups createdAt updatedAt').lean(),
    Order.find({ 
      status: { $not: /^(new|pending|cancelled)$/i },
      ...(isAllTime ? {} : { createdAt: { $gte: queryMinStart, $lte: queryMaxEnd } })
    }).select('lead_id task_created_by created_by verified_by source_order_id status createdAt updatedAt')
      .populate('lead_id', 'assignedTo status')
      .lean(),
    ShipmaxxOrder.find({ 
      status: { $not: /^(new|pending|cancelled)$/i },
      ...(isAllTime ? {} : { createdAt: { $gte: queryMinStart, $lte: queryMaxEnd } })
    }).select('lead_id task_created_by created_by verified_by source_order_id status createdAt updatedAt')
      .populate('lead_id', 'assignedTo status')
      .lean(),
    ReorderCommission.aggregate([
      { $match: { 
          status: { $in: ['pending', 'paid'] },
          ...(isAllTime ? {} : { createdAt: { $gte: queryMinStart, $lte: queryMaxEnd } }) 
      }},
      { $group: { _id: '$staff_id', totalCommission: { $sum: '$commission_amount' } } }
    ])
  ]);

  // Process Commissions
  for (const c of allCommissions) {
    const uid = String(c._id);
    if (statsMap[uid]) {
      statsMap[uid].commission = c.totalCommission || 0;
    }
  }

  // Helper to check date range
  const isToday = (date) => isAllTime || (new Date(date) >= startOfDay && new Date(date) <= endOfDay);
  const isMonth = (date) => new Date(date) >= monthStart && new Date(date) <= monthEnd;

  // Process Attendances
  for (const a of allAttendances) {
    const uid = String(a.user);
    if (statsMap[uid]) {
      let liveHours = 0;
      if (a.checkIn && !a.checkOut) liveHours = (Date.now() - new Date(a.checkIn).getTime()) / (1000 * 60 * 60);
      statsMap[uid].workingHours += (a.workingHours || 0) + liveHours;
    }
  }

  // Finalize attendance workingPercentage and doctor appointments
  for (const uid in statsMap) {
    const expectedHours = 9; // Max 1 attendance per day per user assumed in loop
    statsMap[uid].workingPercentage = Math.min(Math.round((statsMap[uid].workingHours / expectedHours) * 100), 100);
    
    if (statsMap[uid].user.role === 'doctor') {
      const docRegex = new RegExp(statsMap[uid].user.name.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&'), 'i');
      for (const app of allAppointments) {
        if (docRegex.test(app.doctorName)) {
          statsMap[uid].totalAppointments++;
          if (app.status === 'completed') statsMap[uid].completedAppointments++;
          if (app.status === 'cancelled') statsMap[uid].cancelledAppointments++;
        }
      }
    }
  }

  // Process Targets
  for (const t of allTargets) {
    const uid = String(t.user);
    if (statsMap[uid]) statsMap[uid].todayTarget += (t.target || 0);
  }

  // Process Verifications
  for (const v of allVerifications) {
    const uid = String(v.verifiedBy || v.assignedTo);
    if (statsMap[uid] && statsMap[uid].user.role !== 'doctor') {
      statsMap[uid].assignedVerifications++;
      if (isToday(v.createdAt)) {
        statsMap[uid].todayVerifications++;
        statsMap[uid].verifiedCount++;
      }
      if (isMonth(v.createdAt)) statsMap[uid].monthVerifications++;
      if (isToday(v.updatedAt) && v.status === 'on_hold') {
        statsMap[uid].onHoldCount++;
      }
    }
  }

  const addNoteStats = (uid, n, cat) => {
    if (!statsMap[uid] || !isToday(n.createdAt)) return;
    const key = `${new Date(n.createdAt).getTime()}_${(n.text || '').trim()}`;
    if (!statsMap[uid]._noteSet.has(key)) {
      statsMap[uid]._noteSet.add(key);
      statsMap[uid].commentsCount++;
      if (cat === 'cnp') statsMap[uid].cnpComments++;
      else if (cat === 'call_again') statsMap[uid].callAgainComments++;
      else if (cat === 'interested') statsMap[uid].interestedComments++;
    }
  };

  // Process Cnp (Strict CRM rule: exclusively count updated Cnp documents)
  for (const c of allCnps) {
    const uid = String(c.assignedTo || '');
    if (statsMap[uid] && isToday(c.updatedAt)) {
      statsMap[uid].todayCnp++;
    }
    if (c.notes && c.notes.length) {
      for (const n of c.notes) addNoteStats(n.createdBy ? String(n.createdBy) : uid, n, 'cnp');
    }
  }

  // Process CallAgain (Strict CRM rule: exclusively count updated CallAgain documents)
  for (const ca of allCallAgains) {
    const uid = String(ca.assignedTo || '');
    if (statsMap[uid] && isToday(ca.updatedAt)) {
      if (ca.status !== 'interested') statsMap[uid].todayCallAgain++;
      if (ca.status === 'interested') statsMap[uid].todayInterested++;
    }
    if (ca.notes && ca.notes.length) {
      for (const n of ca.notes) addNoteStats(n.createdBy ? String(n.createdBy) : uid, n, ca.status === 'interested' ? 'interested' : 'call_again');
    }
  }

  // Process Tasks
  for (const t of allTasks) {
    const uid = String(t.assignedTo || '');
    if (statsMap[uid] && statsMap[uid].user.role !== 'doctor') {
      if (t.status === 'pending') statsMap[uid].pendingTasks++;
      if (isAllTime || (t.createdAt && new Date(t.createdAt).getTime() >= startOfDay.getTime() && new Date(t.createdAt).getTime() <= endOfDay.getTime())) {
        statsMap[uid].tasksAssigned++;
      }
      if (isToday(t.updatedAt)) {
        if (t.status === 'interested') {
          statsMap[uid].todayInterested++;
        }
        if (t.status === 'cancel_call') statsMap[uid].todayNotInterested++;
      }
    }
    if (t.notes && t.notes.length) {
      const isInterestedToday = t.status === 'interested' && isToday(t.updatedAt);
      for (const n of t.notes) {
        addNoteStats(n.createdBy ? String(n.createdBy) : uid, n, isInterestedToday ? 'interested' : 'other');
      }
    }
  }

  // Process Leads (Strict CRM rule: only createdAt for leadsAdded / Leads Assigned)
  for (const l of allLeadsData) {
    const uid = String(l.assignedTo || '');
    if (statsMap[uid] && statsMap[uid].user.role !== 'doctor') {
      if (isToday(l.createdAt)) {
        statsMap[uid].leadsAdded++;
      }
      if (isToday(l.updatedAt)) {
        if (l.status === 'closed_lost') statsMap[uid].todayClosedLost++;
      }
    }
    if (l.notes && l.notes.length) {
      for (const n of l.notes) {
        addNoteStats(n.createdBy ? String(n.createdBy) : uid, n, 'other');
      }
    }
    if (l.follow_ups && l.follow_ups.length) {
      for (const f of l.follow_ups) {
        if (f.note) {
          let cat = 'other';
          if (l.cnp) cat = 'cnp';
          else if (l.status === 'follow_up') cat = 'call_again';
          else if (l.status === 'interested') cat = 'interested';
          const noteObj = {
            text: f.note,
            createdAt: f.date,
            createdBy: f.createdBy
          };
          addNoteStats(f.createdBy ? String(f.createdBy) : uid, noteObj, cat);
        }
      }
    }
  }

  // Process Orders (SR and SM)
  const processOrder = (o) => {
    const lUid = o.lead_id && typeof o.lead_id === 'object' ? String(o.lead_id.assignedTo) : null;
    let uid = lUid;
    
    if (!uid && o.created_by) {
      const createdByUid = String(o.created_by._id || o.created_by);
      if (statsMap[createdByUid] && statsMap[createdByUid].user.role === 'sales') {
        uid = createdByUid;
      }
    }

    if (uid && statsMap[uid] && statsMap[uid].user.role !== 'doctor') {
      if (isToday(o.createdAt)) statsMap[uid].readyToShipmentCount++;
      if (isMonth(o.createdAt)) statsMap[uid].monthDispatchedCount++;
    }
  };

  for (const o of allOrdersSR) processOrder(o);
  for (const o of allOrdersSM) processOrder(o);

  const synchronizedDeliveries = await getSynchronizedDeliveredOrders(isAllTime ? null : startOfDay, isAllTime ? null : endOfDay, Order, ShipmaxxOrder, true);
  
  // RTO lookback: 45 days (1 month 15 days) from the end of the period
  const rtoLookbackStart = isAllTime ? null : new Date(endOfDay.getTime() - 45 * 24 * 60 * 60 * 1000);
  const rtoTimeFilter = isAllTime ? {} : {
    createdAt: { $gte: rtoLookbackStart, $lte: endOfDay }
  };

  const [rtoOrdersSM, rtoOrdersSR] = await Promise.all([
    ShipmaxxOrder.find({ status: { $regex: /^(rto|rra)/i }, ...rtoTimeFilter })
      .select('_id lead_id createdAt source_order_id task_created_by verified_by created_by')
      .populate('lead_id', 'assignedTo')
      .lean(),
    Order.find({ status: { $regex: /^(rto|rra)/i }, ...rtoTimeFilter })
      .select('_id lead_id createdAt source_order_id task_created_by verified_by created_by')
      .populate('lead_id', 'assignedTo')
      .lean()
  ]);

  const allRtos = [...rtoOrdersSR, ...rtoOrdersSM];
  for (const o of allRtos) {
    const isOldRto = Boolean(o.source_order_id);
    const lUid = o.lead_id ? String(o.lead_id.assignedTo || '') : null;
    const cId = o.created_by ? String(o.created_by) : null;
    
    // Original processOrder logic: Priority to Lead Owner (Sales), fallback to created_by (if Sales)
    let uid = lUid;
    if (!uid && cId) {
      if (statsMap[cId] && statsMap[cId].user.role === 'sales') uid = cId;
    }

    if (uid && statsMap[uid]) {
      statsMap[uid].rtoCount++;
    }
  }
  
  const { phoneToSales, leadMap: histLeadMap } = await getPhoneToSalesAgentMap(Order, ShipmaxxOrder, Lead, statsMap, synchronizedDeliveries);

  // totalUniqueDelivered is already declared at line 410
  let trueNewCount = 0;         // True count of 1st kit deliveries across all orders
  let trueRepeatCount = 0;      // True count of 2nd+ kit deliveries across all orders

  for (const o of synchronizedDeliveries) {
    const phone = (o.billing_phone || (o.lead_id && (typeof o.lead_id === 'object' ? o.lead_id.phone : (histLeadMap[String(o.lead_id)]?.phone || ''))))?.replace(/\D/g, '').slice(-10);
    const isOld = Boolean(o.source_order_id);
    const tId = o.task_created_by ? String(o.task_created_by._id || o.task_created_by) : null;
    const vId = o.verified_by ? String(o.verified_by._id || o.verified_by) : null;
    const cId = o.created_by ? String(o.created_by._id || o.created_by) : null;
    const lId = o.lead_id && typeof o.lead_id === 'object' ? String(o.lead_id.assignedTo || '') : (o.lead_id ? String(histLeadMap[String(o.lead_id)]?.assignedTo || '') : null);

    if (isOld) trueRepeatCount++;
    else trueNewCount++;

    // Track whether this physical order has been counted in uniqueDeliveredCount for any staff
    let uniqueCountedForStaff = null;

    if (!isOld) {
      // New order (first kit) — attribute to lead owner
      const candidates = [tId, lId, vId, cId].filter(Boolean);
      for (const cand of candidates) {
        if (statsMap[cand]) {
          if (statsMap[cand].user.role === 'support' || statsMap[cand].user.role === 'logistics') {
            // Support/Logistics handled a new order — counts as Support's re-verification delivery
            statsMap[cand].supportOldDeliveredCount++;
            statsMap[cand].deliveredCount++;
            if (!uniqueCountedForStaff) {
              statsMap[cand].uniqueDeliveredCount++;
              uniqueCountedForStaff = cand;
            }
            // Also credit the original Sales agent (dual attribution - does NOT inflate unique count)
            if (phone && phoneToSales[phone] && statsMap[phoneToSales[phone]]) {
              statsMap[phoneToSales[phone]].newDeliveredCount++;
              statsMap[phoneToSales[phone]].deliveredCount++;
            }
          } else {
            // Sales staff owns this lead — 1st kit delivery
            statsMap[cand].newDeliveredCount++;
            statsMap[cand].deliveredCount++;
            if (!uniqueCountedForStaff) {
              statsMap[cand].uniqueDeliveredCount++;
              uniqueCountedForStaff = cand;
            }
          }
          break;
        }
      }
    } else {
      // Reorder (2nd+ kit) — credit Support/Logistics who re-verified it
      const supportCand = [vId, cId, lId].filter(Boolean);
      for (const cand of supportCand) {
        if (statsMap[cand] && (statsMap[cand].user.role === 'support' || statsMap[cand].user.role === 'logistics')) {
          statsMap[cand].supportOldDeliveredCount++;
          statsMap[cand].deliveredCount++;
          if (!uniqueCountedForStaff) {
            statsMap[cand].uniqueDeliveredCount++;
            uniqueCountedForStaff = cand;
          }
          break;
        }
      }
      // Also credit original Sales agent via phone map (dual attribution - does NOT inflate unique count)
      if (phone && phoneToSales[phone] && statsMap[phoneToSales[phone]]) {
        statsMap[phoneToSales[phone]].salesOldDeliveredCount++;
        statsMap[phoneToSales[phone]].deliveredCount++;
        // If no support was found, count unique under sales
        if (!uniqueCountedForStaff) {
          statsMap[phoneToSales[phone]].uniqueDeliveredCount++;
          uniqueCountedForStaff = phoneToSales[phone];
        }
      }
    }

    // Count every order exactly once in the grand total
    if (uniqueCountedForStaff) totalUniqueDelivered++;
  }

  for (const k in statsMap) {
    delete statsMap[k]._intSet;
    delete statsMap[k]._noteSet;
    delete statsMap[k]._cnpSet;
    delete statsMap[k]._caSet;
  }

  const staffStats = Object.values(statsMap);
  
  const isStaff = requestingUser && ['sales', 'support', 'logistics'].includes(requestingUser.role);

  return {
    staffStats, // The array of stats per staff
    _totalUniqueDelivered: isStaff && staffStats.length ? staffStats[0].deliveredCount : synchronizedDeliveries.length,
    _totalAttributed: isStaff && staffStats.length ? staffStats[0].deliveredCount : totalUniqueDelivered,
    _totalUnattributed: isStaff ? 0 : synchronizedDeliveries.length - totalUniqueDelivered,
    _totalTrueNew: isStaff && staffStats.length ? staffStats[0].newDeliveredCount : trueNewCount,
    _totalTrueRepeat: isStaff && staffStats.length ? (staffStats[0].salesOldDeliveredCount + (staffStats[0].supportOldDeliveredCount || staffStats[0].oldDeliveredCount || 0)) : trueRepeatCount,
  };
};


export const getDashboardStats = async (userRole, userId, targetDate, from, to, userDepartments = []) => {
  const uid = userId ? new mongoose.Types.ObjectId(userId) : null;
  // For countDocuments - plugin auto-adds isDeleted:false
  const countFilter = {};
  // For aggregate - plugin does NOT apply, must be explicit
  const aggMatch = { isDeleted: false };

  if (userRole === 'sales' && uid) {
    countFilter.assignedTo = uid;
    aggMatch.assignedTo = uid;
  }
  
  if (userDepartments && userDepartments.length > 0) {
    countFilter.department = { $in: userDepartments };
    aggMatch.department = { $in: userDepartments };
  }

  const rtsAggMatch = {};
  if (userRole === 'sales' && uid) {
    rtsAggMatch.assignedTo = uid;
  }
  if (userDepartments && userDepartments.length > 0) {
    rtsAggMatch.department = { $in: userDepartments };
  }

  const IST_OFFSET = 5.5 * 60 * 60 * 1000;
  let start, end;

  const isAllTime = from === 'all' || to === 'all';
  if (isAllTime) {
    const target = targetDate ? new Date(targetDate) : new Date();
    start = new Date(Date.UTC(target.getFullYear(), target.getMonth(), target.getDate()) - IST_OFFSET);
    end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
  } else if (from && to) {
    start = new Date(`${from}T00:00:00.000+05:30`);
    end = new Date(`${to}T23:59:59.999+05:30`);
  } else {
    const target = targetDate ? new Date(targetDate) : new Date();
    start = new Date(Date.UTC(target.getFullYear(), target.getMonth(), target.getDate()) - IST_OFFSET);
    end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
  }

  const Attendance = (await import('../attendance/attendance.model.js')).default;
  const User = (await import('../user/user.model.js')).default;
  const ReadyToShipment = (await import('../readytoshipment/readytoshipment.model.js')).default;

  const dateFilter = isAllTime ? {} : { createdAt: { $gte: start, $lte: end } };
  const updateDateFilter = isAllTime ? {} : { updatedAt: { $gte: start, $lte: end } };
  // departmentCountFilter always includes the date range so migraine/piles counts are period-accurate
  const departmentCountFilter = (department) => {
    if (countFilter.department?.$in && !countFilter.department.$in.includes(department)) {
      return { ...countFilter, department: '__none__', ...dateFilter };
    }
    return { ...countFilter, department, ...dateFilter };
  };

  const [
    totalLeads,
    newLeadsToday,
    migraineLeadCount,
    pilesLeadCount,
    convertedLeads,
    readyToShipmentCount,
    readyToShipBreakdown,
    revenueResult,
    funnelData,
    sourceData,
    pendingTasks,
    overdueTasks,
    attendanceToday,
    totalStaffCount,
    todayCnp,
    todayCallAgain,
    todayInterested,
    todayNotInterested,
    taskToVerificationCount,
    pendingVerificationsCount,
    readyToShipCreatedCount,
    migraineTaskToVerification,
    pilesTaskToVerification,
    migrainePendingVerifications,
    pilesPendingVerifications,
  ] = await Promise.all([
    Lead.countDocuments(countFilter),

    Lead.countDocuments({ ...countFilter, ...dateFilter }),

    Lead.countDocuments(departmentCountFilter('migraine')),

    Lead.countDocuments(departmentCountFilter('piles')),

    // verified: count Verification records marked 'verified' in the period (this IS the conversion)
    Verification.countDocuments({ ...countFilter, status: 'verified', isDeleted: false, ...updateDateFilter }),

    ReadyToShipment.countDocuments({ 
      ...countFilter,
      sentToShiprocket: { $ne: true }
    }),
    
    ReadyToShipment.aggregate([
      { $match: { ...rtsAggMatch, sentToShiprocket: { $ne: true } } },
      {
        $lookup: {
          from: 'leads',
          localField: 'lead',
          foreignField: '_id',
          as: 'leadDoc'
        }
      },
      { $unwind: '$leadDoc' },
      {
        $group: {
          _id: {
            $cond: [
              { $or: [{ $eq: ['$leadDoc.status', 'old'] }, { $ifNull: ['$leadDoc.pending_reorder_source', false] }] },
              'old',
              'new'
            ]
          },
          count: { $sum: 1 }
        }
      }
    ]),

    Lead.aggregate([
      { $match: { ...aggMatch, status: 'closed_won', ...(isAllTime ? {} : { updatedAt: { $gte: start, $lte: end } }) } },
      { $group: { _id: null, total: { $sum: '$revenue' } } },
    ]),

    Lead.aggregate([
      { $match: { ...aggMatch, ...dateFilter } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),

    Lead.aggregate([
      { $match: { ...aggMatch, ...dateFilter } },
      { $group: { _id: '$source', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),

    Task.countDocuments({
      ...countFilter,
      status: 'pending',
    }),

    Task.countDocuments({
      ...countFilter,
      status: 'overdue',
    }),

    Attendance.find({ date: { $gte: start, $lte: end }, isDeleted: false }).populate('user', 'departments').lean(),

    User.countDocuments({ 
      role: { $in: ['sales', 'manager', 'support'] }, 
      isDeleted: false,
      ...(userDepartments?.length > 0 ? { departments: { $in: userDepartments } } : {})
    }),

    Cnp.countDocuments({ ...countFilter, ...updateDateFilter }),
    CallAgain.countDocuments({ ...countFilter, ...updateDateFilter }),
    Task.countDocuments({ ...countFilter, status: 'interested', isDeleted: false, ...updateDateFilter }),
    Task.countDocuments({ ...countFilter, status: 'cancel_call', isDeleted: false, ...updateDateFilter }),
    Verification.countDocuments({ ...countFilter, isDeleted: false, ...dateFilter }),
    Verification.countDocuments({ ...countFilter, status: 'pending', isDeleted: false }),
    ReadyToShipment.countDocuments({ ...countFilter, ...(isAllTime ? {} : { createdAt: { $gte: start, $lte: end } }) }),
    Verification.countDocuments({ ...countFilter, department: 'migraine', isDeleted: false, ...dateFilter }),
    Verification.countDocuments({ ...countFilter, department: 'piles', isDeleted: false, ...dateFilter }),
    Verification.countDocuments({ ...countFilter, department: 'migraine', status: 'pending', isDeleted: false }),
    Verification.countDocuments({ ...countFilter, department: 'piles', status: 'pending', isDeleted: false }),
  ]);

  const newReadyToShipCount = readyToShipBreakdown?.find(b => b._id === 'new')?.count || 0;
  const oldReadyToShipCount = readyToShipBreakdown?.find(b => b._id === 'old')?.count || 0;

  const stageOrder = ['new', 'contacted', 'interested', 'follow_up', 'closed_won', 'closed_lost'];
  const funnelMap = Object.fromEntries(funnelData.map((f) => [f._id, f.count]));
  const salesFunnel = stageOrder.map((stage) => ({ stage, count: funnelMap[stage] || 0 }));

  const sourcePerformance = sourceData.map((s) => ({
    source: s._id || 'other',
    count: s.count,
    percentage: newLeadsToday ? Math.round((s.count / newLeadsToday) * 100) : (totalLeads ? Math.round((s.count / totalLeads) * 100) : 0),
  }));

  const filteredAttendance = userDepartments?.length > 0 
    ? attendanceToday.filter(a => a.user?.departments?.some(d => userDepartments.includes(d)))
    : attendanceToday;

  const attendanceStats = {
    present: filteredAttendance.filter(a => a.checkIn).length,
    checkedOut: filteredAttendance.filter(a => a.checkOut).length,
    absent: Math.max(0, totalStaffCount - filteredAttendance.filter(a => a.checkIn).length),
    totalStaff: totalStaffCount
  };

  // Per-department conversion: Verification records marked 'verified' for each department in the period
  const verifDeptFilter = (dept) => {
    if (countFilter.department && countFilter.department['$in'] && !countFilter.department['$in'].includes(dept)) {
      return { ...countFilter, department: '__none__', status: 'verified', isDeleted: false, ...updateDateFilter };
    }
    return { ...countFilter, department: dept, status: 'verified', isDeleted: false, ...updateDateFilter };
  };

  const [todayClosedLost, migraineConverted, pilesConverted] = await Promise.all([
    Lead.countDocuments({ ...countFilter, status: 'closed_lost', ...updateDateFilter }),
    Verification.countDocuments(verifDeptFilter('migraine')),
    Verification.countDocuments(verifDeptFilter('piles')),
  ]);

  const activityStats = {
    todayCnp,
    todayCallAgain,
    todayInterested,
    todayNotInterested,
    todayClosedLost,
  };

  // Build order match using $lookup aggregation to avoid loading all lead IDs into memory
  const buildOrderMatch = () => isAllTime ? {} : { createdAt: { $gte: start, $lte: end } };

  const buildDeliveredMatch = () => {
    const statusList = ['DELIVERED', 'Delivered', 'delivered', 'DEL', 'del'];
    if (isAllTime) return { status: { $in: statusList } };

    return { 
      createdAt: { $gte: start, $lte: end },
      $or: [
        { delivered_at: { $gte: start } },
        { delivered_at: { $exists: false } },
        { delivered_at: null }
      ]
    };
  };

  const currentUid = userId ? new mongoose.Types.ObjectId(userId) : null;
  const needsLeadFilter = userRole === 'sales' || (userDepartments && userDepartments.length > 0);
  const leadMatchConditions = [];
  if (userRole === 'sales' && currentUid) {
    if (userDepartments?.length > 0) {
      leadMatchConditions.push({ '_lead.assignedTo': currentUid, '_lead.department': { $in: userDepartments } });
      leadMatchConditions.push({ lead_id: null, created_by: currentUid });
    } else {
      leadMatchConditions.push({ '_lead.assignedTo': currentUid });
      leadMatchConditions.push({ lead_id: null, created_by: currentUid });
    }
  } else if (userDepartments?.length > 0) {
    leadMatchConditions.push({ '_lead.department': { $in: userDepartments } });
  }

  const leadMatchStage = leadMatchConditions.length > 0 ? [
    { $lookup: { from: 'leads', localField: 'lead_id', foreignField: '_id', as: '_lead' } },
    { $match: { $or: leadMatchConditions } },
  ] : [];

  const allOrderFilter = buildOrderMatch();
  const allOrderFilterSM = { ...allOrderFilter };
  const deliveredFilter = buildDeliveredMatch();
  const deliveredFilterSM = { ...deliveredFilter };

  const backlogFilter = isAllTime ? { _id: null } : {
    status: { $in: ['DELIVERED', 'Delivered', 'delivered', 'DEL', 'del'] },
    createdAt: { $lt: start },
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
  };

  const { getKPIs: getOpsMonthKPIs } = await import('../ops-dashboard/opsDashboard.service.js');

  const [orderBreakdownSR, deliveredBreakdownSR, blSR, orderBreakdownSM, deliveredBreakdownSM, blSM, opsMonthData, smxInTransitCount, smxOfdCount] = await Promise.all([
    Order.aggregate([
      { $match: allOrderFilter },
      ...leadMatchStage,
      { $lookup: { from: 'leads', localField: 'lead_id', foreignField: '_id', as: 'leadDoc' } },
      { $group: { _id: { $cond: [ { $or: [ { $ifNull: ['$source_order_id', false] }, { $eq: [{ $arrayElemAt: ['$leadDoc.status', 0] }, 'old'] } ] }, 'old', 'new' ] }, count: { $sum: 1 } } }
    ]),
    Order.find(deliveredFilter).select('_id lead_id awb_code order_id status created_by createdAt status_updated_at delivered_at sub_total total').populate('lead_id', 'assignedTo department status pending_reorder_source').lean(),
    Order.find(backlogFilter).select('_id lead_id awb_code order_id status created_by createdAt status_updated_at delivered_at sub_total total').populate('lead_id', 'assignedTo department status pending_reorder_source').lean(),
    ShipmaxxOrder.aggregate([
      { $match: allOrderFilterSM },
      ...leadMatchStage,
      { $lookup: { from: 'leads', localField: 'lead_id', foreignField: '_id', as: 'leadDoc' } },
      { $group: { _id: { $cond: [ { $or: [ { $ifNull: ['$source_order_id', false] }, { $eq: [{ $arrayElemAt: ['$leadDoc.status', 0] }, 'old'] } ] }, 'old', 'new' ] }, count: { $sum: 1 } } }
    ]),
    ShipmaxxOrder.find(deliveredFilterSM).select('_id lead_id awb_code order_id status created_by createdAt status_updated_at delivered_at sub_total total').populate('lead_id', 'assignedTo department status pending_reorder_source').lean(),
    ShipmaxxOrder.find(backlogFilter).select('_id lead_id awb_code order_id status created_by createdAt status_updated_at delivered_at sub_total total').populate('lead_id', 'assignedTo department status pending_reorder_source').lean(),
    getOpsMonthKPIs({ preset: 'month', staffId: (userRole === 'sales' && userId) ? String(userId) : undefined }).catch(() => null),
    ShipmaxxOrder.countDocuments({ status: { $in: ['IN_TRANSIT', 'IN TRANSIT', 'INT', 'in_transit'] } }),
    ShipmaxxOrder.countDocuments({ status: { $in: ['OUT_FOR_DELIVERY', 'OUT FOR DELIVERY', 'OFD', 'out_for_delivery'] } })
  ]);

  const filterOrderList = (arr) => {
    if (!needsLeadFilter) return arr;
    return arr.filter(o => {
      const l = o.lead_id && o.lead_id._id ? o.lead_id : null;
      if (userRole === 'sales' && currentUid) {
        const isOld = Boolean(o.source_order_id);
        const taskCreator = o.task_created_by ? (o.task_created_by._id ? String(o.task_created_by._id) : String(o.task_created_by)) : null;
        const verifier = o.verified_by ? (o.verified_by._id ? String(o.verified_by._id) : String(o.verified_by)) : null;
        const leadOwner = l && l.assignedTo ? String(l.assignedTo) : null;
        const creator = o.created_by ? String(o.created_by) : null;
        const assignedUser = isOld ? (verifier || leadOwner || creator) : (taskCreator || verifier || leadOwner || creator);
        const matchesStaff = assignedUser === String(currentUid);
        if (!matchesStaff) return false;
      }
      if (userDepartments && userDepartments.length > 0) {
        if (!l || !l.department || !userDepartments.includes(l.department)) return false;
      }
      return true;
    });
  };

  const mergeBreakdown = (sr, sm) => {
    const res = {};
    for (const b of sr) res[b._id] = (res[b._id] || 0) + b.count;
    for (const b of sm) res[b._id] = (res[b._id] || 0) + b.count;
    return Object.keys(res).map(_id => ({ _id, count: res[_id] }));
  };

  const orderBreakdown = mergeBreakdown(orderBreakdownSR, orderBreakdownSM);
  
  const dedupOrders = (arr) => {
    // Exact Ops Dashboard deduplication logic (sort descending -> awb_code -> order_id -> _id)
    arr.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    const seen = new Set();
    const res = [];
    for (const o of arr) {
      const key = o.awb_code ? 'awb_' + o.awb_code : (o.order_id ? 'ord_' + o.order_id : 'id_' + String(o._id));
      if (!seen.has(key)) {
        seen.add(key);
        res.push(o);
      }
    }
    return res;
  };

  // Accurate Kit Calculation for Delivered Orders (Exact Ops Dashboard Split Cohort vs Backlog matching)
  const statusDelList = ['DELIVERED', 'DEL', 'Delivered', 'delivered', 'del'];
  const isDelivOrder = (o) => statusDelList.includes((o.status || '').trim()) || statusDelList.includes((o.status || '').trim().toUpperCase());
  const cohortDelivered = isAllTime
    ? dedupOrders([...filterOrderList(deliveredBreakdownSR), ...filterOrderList(deliveredBreakdownSM)])
    : dedupOrders([...filterOrderList(deliveredBreakdownSR), ...filterOrderList(deliveredBreakdownSM)]).filter(isDelivOrder);
  const backlogDelivered = dedupOrders([...filterOrderList(blSR), ...filterOrderList(blSM)]);
  const allDeliveredOrders = [...cohortDelivered, ...backlogDelivered];
  let newDeliveredCount = 0;
  let oldDeliveredCount = 0;
  
  if (allDeliveredOrders.length > 0) {
    const dLeadIds = allDeliveredOrders.map(o => o.lead_id ? (o.lead_id._id ? o.lead_id._id : o.lead_id) : null).filter(Boolean);
    const [allPastOrders, allPastSmOrders, oldLeads] = await Promise.all([
      Order.find({ lead_id: { $in: dLeadIds } }).select('_id lead_id createdAt').lean(),
      ShipmaxxOrder.find({ lead_id: { $in: dLeadIds } }).select('_id lead_id createdAt').lean(),
      Lead.find({ _id: { $in: dLeadIds }, $or: [{ status: 'old' }, { pending_reorder_source: { $exists: true, $ne: null } }] }).distinct('_id')
    ]);
    const oldLeadsSet = new Set(oldLeads.map(id => String(id)));
    const combinedPast = [...allPastOrders, ...allPastSmOrders].sort((a,b) => new Date(a.createdAt) - new Date(b.createdAt));
    
    const leadOrderCount = {};
    const kitMap = {};
    for (const oc of combinedPast) {
      if (!oc.lead_id) continue;
      const lId = String(oc.lead_id);
      if (!leadOrderCount[lId]) leadOrderCount[lId] = 0;
      leadOrderCount[lId]++;
      kitMap[String(oc._id)] = (leadOrderCount[lId] >= 2 || (leadOrderCount[lId] === 1 && oldLeadsSet.has(lId))) ? 'old' : 'new';
    }
    
    for (const o of allDeliveredOrders) {
      const type = kitMap[String(o._id)] || 'new';
      if (type === 'old') oldDeliveredCount++;
      else newDeliveredCount++;
    }
  }

  // Duplicated mergeBreakdown removed
  const deliveredRevenueTotal = allDeliveredOrders.reduce((sum, o) => sum + (Number(o.sub_total) || Number(o.total) || 0), 0);

  const newOrdersCount = orderBreakdown.find(b => b._id === 'new')?.count || 0;
  const oldOrdersCount = orderBreakdown.find(b => b._id === 'old')?.count || 0;
  const deliveredCount = newDeliveredCount + oldDeliveredCount;
  const departmentLeads = {
    migraine: migraineLeadCount,
    piles: pilesLeadCount,
    total: migraineLeadCount + pilesLeadCount,
  };

  const migraineConversionRate = migraineLeadCount > 0 ? Math.round((migraineConverted / migraineLeadCount) * 100) : 0;
  const pilesConversionRate = pilesLeadCount > 0 ? Math.round((pilesConverted / pilesLeadCount) * 100) : 0;

  // Overall conversion rate: verified / new leads in selected period
  const conversionRate = newLeadsToday > 0 ? Math.round((convertedLeads / newLeadsToday) * 100) : 0;

  const k = opsMonthData?.kpis || {};
  const monthlyDispatched = k.totalShipments?.value || 0;
  const monthlyDelivered = k.delivered?.value || 0;
  const monthlyDeliveryRate = Math.round(k.deliveredRate?.value || 0);
  const monthlyRto = (k.rto?.value || 0) + (k.rtoIntersite?.value || 0);
  const monthlyRtoRate = Math.round(k.rtoRate?.value || 0);
  const monthlyInTransit = smxInTransitCount ?? 0;
  const monthlyOfd = smxOfdCount ?? (k.ofd?.value || 0);
  const monthlyPureInTransit = smxInTransitCount ?? 0;
  const monthlyInTransitRate = monthlyDispatched > 0 ? Math.round((monthlyInTransit / monthlyDispatched) * 100) : 0;

  return {
    totalLeads,
    newLeadsToday,
    departmentLeads,
    convertedLeads,
    readyToShipmentCount,
    newReadyToShipCount,
    oldReadyToShipCount,
    revenue: revenueResult[0]?.total || 0,
    conversionRate,
    migraineConversionRate,
    pilesConversionRate,
    migraineConverted,
    pilesConverted,
    salesFunnel,
    sourcePerformance,
    tasks: { pending: pendingTasks, overdue: overdueTasks },
    attendance: attendanceStats,
    activity: activityStats,
    newOrdersCount,
    oldOrdersCount,
    deliveredCount,
    newDeliveredCount,
    oldDeliveredCount,
    deliveredRevenue: deliveredRevenueTotal,
    taskToVerificationCount,
    pendingVerificationsCount,
    readyToShipCreatedCount,
    migraineTaskToVerification,
    pilesTaskToVerification,
    migrainePendingVerifications,
    pilesPendingVerifications,
    monthlyShipments: {
      dispatched: monthlyDispatched,
      delivered: monthlyDelivered,
      rto: monthlyRto,
      inTransit: monthlyInTransit,
      inTransitCount: monthlyPureInTransit,
      ofdCount: monthlyOfd,
      deliveryRate: monthlyDeliveryRate,
      rtoRate: monthlyRtoRate,
      inTransitRate: monthlyInTransitRate,
    },
  };
};

export async function getSynchronizedDeliveredOrders(monthStart, monthEnd, OrderModel, ShipmaxxOrderModel, populateDetails = true) {
  // Match Ops Dashboard classifyStatus: 'DELIVERED' or 'DEL' (case-insensitive)
  const deliveredStatus = { $in: ['DELIVERED', 'Delivered', 'delivered', 'DEL', 'del'] };
  const selectFields = '_id lead_id task_created_by created_by verified_by source_order_id sub_total total awb_code order_id createdAt status status_updated_at delivered_at billing_customer_name billing_phone platform';

  const dedupOrders = (arr) => {
    arr.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    const seen = new Set();
    const res = [];
    for (const o of arr) {
      const key = o.awb_code ? 'awb_' + o.awb_code : (o.order_id ? 'ord_' + o.order_id : 'id_' + String(o._id));
      if (!seen.has(key)) {
        seen.add(key);
        res.push(o);
      }
    }
    return res;
  };

  const popList = [
    { path: 'lead_id', select: 'assignedTo status name phone' },
    { path: 'created_by', select: 'name role' },
    { path: 'verified_by', select: 'name role' }
  ];

  if (!monthStart || !monthEnd) {
    let q1SR = OrderModel.find({ status: deliveredStatus }).select(selectFields);
    let q1SM = ShipmaxxOrderModel.find({ status: deliveredStatus }).select(selectFields);
    if (populateDetails) {
      q1SR = q1SR.populate(popList);
      q1SM = q1SM.populate(popList);
    }
    const [sr, sm] = await Promise.all([q1SR.lean(), q1SM.lean()]);
    return dedupOrders([...sr, ...sm]);
  }

  // Cohort: orders CREATED this period that are delivered
  const cohortQuery = {
    status: deliveredStatus,
    createdAt: { $gte: monthStart, $lte: monthEnd },
    $or: [
      { delivered_at: { $gte: monthStart } },
      { delivered_at: { $exists: false } },
      { delivered_at: null }
    ]
  };

  // Backlog: orders created BEFORE this period but delivered_at / status_updated_at falls within
  // Matches Ops Dashboard backlogDeliveredFilter exactly
  const backlogQuery = {
    status: deliveredStatus,
    createdAt: { $lt: monthStart },
    $or: [
      { delivered_at: { $gte: monthStart, $lte: monthEnd } },
      {
        $and: [
          { status_updated_at: { $gte: monthStart, $lte: monthEnd } },
          {
            $or: [
              { delivered_at: null },
              { $expr: { $eq: ["$delivered_at", "$createdAt"] } }
            ]
          }
        ]
      }
    ]
  };

  let q1SR = OrderModel.find(cohortQuery).select(selectFields);
  let q2SR = OrderModel.find(backlogQuery).select(selectFields);
  let q1SM = ShipmaxxOrderModel.find(cohortQuery).select(selectFields);
  let q2SM = ShipmaxxOrderModel.find(backlogQuery).select(selectFields);

  if (populateDetails) {
    q1SR = q1SR.populate(popList);
    q2SR = q2SR.populate(popList);
    q1SM = q1SM.populate(popList);
    q2SM = q2SM.populate(popList);
  }

  const [cohortSR, backlogSR, cohortSM, backlogSM] = await Promise.all([
    q1SR.lean(), q2SR.lean(), q1SM.lean(), q2SM.lean()
  ]);

  return dedupOrders([...cohortSR, ...backlogSR, ...cohortSM, ...backlogSM]);
}

export async function getPhoneToSalesAgentMap(OrderModel, ShipmaxxOrderModel, LeadModel, userOrStatsMap, targetOrders = null) {
  let allHistory;
  if (targetOrders && Array.isArray(targetOrders) && targetOrders.length <= 500) {
    if (targetOrders.length === 0) return { phoneToSales: {}, leadMap: {} };
    const phones = targetOrders.map(o => (o.billing_phone || '').replace(/\D/g, '').slice(-10)).filter(p => p.length >= 10);
    const uniquePhones = [...new Set(phones)];
    if (uniquePhones.length === 0) {
      allHistory = targetOrders;
    } else {
      const phoneRegexes = uniquePhones.map(p => new RegExp(p + '$'));
      const selectFields = '_id lead_id task_created_by created_by verified_by source_order_id billing_phone status createdAt';
      const statusList = ['DELIVERED', 'Delivered', 'delivered', 'DEL', 'del'];
      const [sr, sm] = await Promise.all([
        OrderModel.find({ billing_phone: { $in: phoneRegexes }, status: { $in: statusList } }).select(selectFields).lean(),
        ShipmaxxOrderModel.find({ billing_phone: { $in: phoneRegexes }, status: { $in: statusList } }).select(selectFields).lean()
      ]);
      allHistory = [...sr, ...sm];
    }
  } else {
    allHistory = await getSynchronizedDeliveredOrders(null, null, OrderModel, ShipmaxxOrderModel, false);
  }

  const allLeadIds = [...new Set(allHistory.map(o => o.lead_id).filter(Boolean).map(String))];
  const allLeads = allLeadIds.length > 0 ? await LeadModel.find({ _id: { $in: allLeadIds } }).select('_id assignedTo createdBy phone').lean() : [];
  const leadMap = {};
  for (const l of allLeads) leadMap[String(l._id)] = l;

  const phoneToSales = {};
  const isSales = (uid) => {
    if (!uid) return false;
    const item = userOrStatsMap[String(uid)];
    if (!item) return false;
    const role = item.role || (item.user && item.user.role);
    return role === 'sales';
  };

  for (const o of allHistory) {
    const phone = (o.billing_phone || (o.lead_id && leadMap[String(o.lead_id)] ? leadMap[String(o.lead_id)].phone : ''))?.replace(/\D/g, '').slice(-10);
    if (!phone || phone.length < 10) continue;

    if (!phoneToSales[phone]) {
      const isOld = Boolean(o.source_order_id);
      const lId = o.lead_id ? leadMap[String(o.lead_id)] : null;
      const candidates = isOld ? [o.verified_by, lId?.assignedTo, lId?.createdBy, o.created_by].filter(Boolean).map(String) : [o.task_created_by, o.verified_by, lId?.assignedTo, lId?.createdBy, o.created_by].filter(Boolean).map(String);
      for (const cand of candidates) {
        if (isSales(cand)) {
          phoneToSales[phone] = cand;
          break;
        }
      }
    }
  }
  return { phoneToSales, leadMap };
}

export const getAllStaffCommissions = async (month, year) => {
  const User = (await import('../user/user.model.js')).default;
  const Attendance = (await import('../attendance/attendance.model.js')).default;
  const CommissionOverride = (await import('../commission/commissionOverride.model.js')).default;
  const ReorderCommission = (await import('../commission/reorderCommission.model.js')).default;
  const Lead = (await import('../lead/lead.model.js')).default;
  const { Order } = await import('../shiprocket/models/order.model.js');
  const { ShipmaxxOrder } = await import('../shipmaxx/models/shipmaxxOrder.model.js');

  const allUsers = await User.find({ role: { $in: ['sales', 'manager', 'staff', 'support', 'logistics'] }, isDeleted: false })
    .select('_id name role baseSalary commissionRate joiningDate createdAt').lean();

  const IST_OFFSET = 5.5 * 60 * 60 * 1000;
  const monthStart = new Date(Date.UTC(year, month, 1) - IST_OFFSET);
  const monthEnd = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999) - IST_OFFSET);

  const statsMap = {};
  for (const u of allUsers) {
    // Check joining date constraint
    const joiningDate = u.joiningDate ? new Date(u.joiningDate) : new Date(u.createdAt);
    if (joiningDate.getFullYear() > year || (joiningDate.getFullYear() === year && joiningDate.getMonth() > month)) {
      continue;
    }
    
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    let billableDays = daysInMonth;
    if (joiningDate.getFullYear() === year && joiningDate.getMonth() === month) {
      billableDays = daysInMonth - joiningDate.getDate() + 1;
    }

    statsMap[String(u._id)] = {
      user: u,
      attendance: { present: 0, absent: 0, half_day: 0, late: 0 },
      totalDeliveries: 0,
      totalRevenue: 0,
      revenueCommission: 0,
      commissionRate: u.commissionRate ?? 5,
      reorderCommission: 0,
      totalCommission: 0,
      basePay: 0,
      totalPay: 0,
      isManualCommission: false,
      workingDays: 0,
      billableDays: Math.max(billableDays, 1),
      override: null
    };
  }

  const [allAttendances, allOverrides, allReorders, allDeliveredOrders] = await Promise.all([
    Attendance.find({ date: { $gte: monthStart, $lte: monthEnd }, isDeleted: false }).select('user status').lean(),
    CommissionOverride.find({ month, year }).lean(),
    ReorderCommission.find({ month, year }).lean(),
    getSynchronizedDeliveredOrders(monthStart, monthEnd, Order, ShipmaxxOrder, true)
  ]);

  for (const a of allAttendances) {
    const uid = String(a.user);
    if (statsMap[uid]) {
      if (statsMap[uid].attendance[a.status] !== undefined) statsMap[uid].attendance[a.status]++;
    }
  }

  for (const o of allOverrides) {
    const uid = String(o.user);
    if (statsMap[uid]) statsMap[uid].override = o;
  }

  for (const r of allReorders) {
    const uid = String(r.staff_id || r.user);
    if (statsMap[uid]) statsMap[uid].reorderCommission += (r.commission_amount || 0);
  }

  const SUB_TOTAL_AMOUNT = (o) => Number(o.sub_total) || Number(o.total) || 0;

  const processOrder = (o) => {
    let uid = null;
    let isReorder = false;
    
    const tId = o.task_created_by ? String(o.task_created_by._id || o.task_created_by) : null;
    const vId = o.verified_by ? String(o.verified_by._id || o.verified_by) : null;
    const cId = o.created_by ? String(o.created_by._id || o.created_by) : null;

    if (o.source_order_id) {
      uid = vId || cId;
      isReorder = true;
    } else {
      const lIdAssignedTo = o.lead_id && typeof o.lead_id === 'object' ? String(o.lead_id.assignedTo) : null;
      uid = tId || vId || lIdAssignedTo || cId;
      if (o.lead_id && typeof o.lead_id === 'object' && o.lead_id.status === 'old') {
        isReorder = true;
      }
    }

    if (uid && statsMap[uid]) {
      statsMap[uid].totalDeliveries++;
      if (!isReorder) {
        statsMap[uid].totalRevenue += SUB_TOTAL_AMOUNT(o);
      }
    }
  };

  for (const o of allDeliveredOrders) processOrder(o);

  let grandTotalDeliveries = allDeliveredOrders.length;
  let grandTotalRevenue = 0;
  for (const o of allDeliveredOrders) grandTotalRevenue += SUB_TOTAL_AMOUNT(o);

  let staffDeliveriesSum = 0;
  let staffRevenueSum = 0;

  const validStaff = [];

  for (const uid in statsMap) {
    const s = statsMap[uid];
    s.workingDays = s.attendance.present + s.attendance.late + s.attendance.half_day;
    s.basePay = s.override?.manualBasePay ?? Math.round((s.user.baseSalary || 0) * (s.workingDays / s.billableDays));
    
    s.revenueCommission = s.user.role === 'support'
      ? s.totalDeliveries * 50
      : Math.round(s.totalRevenue * ((s.user.commissionRate ?? 5) / 100));
      
    s.totalCommission = s.override?.manualCommission ?? (s.revenueCommission + s.reorderCommission);
    s.totalPay = s.basePay + s.totalCommission;
    s.isManualCommission = s.override?.manualCommission != null;

    staffDeliveriesSum += s.totalDeliveries;
    staffRevenueSum += s.totalRevenue;
    validStaff.push(s);
  }

  return {
    staff: validStaff,
    grandTotalDeliveries,
    grandTotalRevenue,
    grandTotalCommission: validStaff.reduce((s, x) => s + (x.totalCommission || 0), 0),
    grandTotalPay: validStaff.reduce((s, x) => s + (x.totalPay || 0), 0),
    unassignedDeliveries: Math.max(0, grandTotalDeliveries - staffDeliveriesSum),
    unassignedRevenue: Math.max(0, grandTotalRevenue - staffRevenueSum),
  };
};

export const getStaffCommission = async (userId, month, year) => {
  const all = await getAllStaffCommissions(month, year);
  const staffData = all.staff.find(s => String(s.user._id) === String(userId));
  return staffData || { totalPay: 0, basePay: 0, totalCommission: 0, totalRevenue: 0 };
};

export const saveCommissionOverride = async ({ userId, month, year, manualCommission, manualBasePay }) => {
  const CommissionOverride = (await import('../commission/commissionOverride.model.js')).default;
  const update = {};
  if (manualCommission !== undefined) update.manualCommission = manualCommission;
  if (manualBasePay !== undefined) update.manualBasePay = manualBasePay;
  return CommissionOverride.findOneAndUpdate(
    { user: userId, month, year },
    { $set: update },
    { upsert: true, returnDocument: 'after' }
  ).lean();
};

export const getRevenueChart = async (userRole, userId, period = 'monthly') => {
  const groupBy = period === 'weekly'
    ? { year: { $year: '$createdAt' }, week: { $week: '$createdAt' } }
    : { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } };

  const sortBy = period === 'weekly'
    ? { '_id.year': 1, '_id.week': 1 }
    : { '_id.year': 1, '_id.month': 1 };

  const matchQ = { status: { $in: ['DELIVERED', 'Delivered', 'delivered'] }, sub_total: { $gt: 0 } };
  
  const [resSR, resSM] = await Promise.all([
    Order.aggregate([
      { $match: matchQ },
      { $group: { _id: groupBy, revenue: { $sum: SUB_TOTAL_AMOUNT }, count: { $sum: 1 } } },
    ]),
    ShipmaxxOrder.aggregate([
      { $match: matchQ },
      { $group: { _id: groupBy, revenue: { $sum: SUB_TOTAL_AMOUNT }, count: { $sum: 1 } } },
    ])
  ]);

  const merged = {};
  for (const item of [...resSR, ...resSM]) {
    const key = JSON.stringify(item._id);
    if (!merged[key]) merged[key] = { _id: item._id, revenue: 0, count: 0 };
    merged[key].revenue += item.revenue;
    merged[key].count += item.count;
  }
  
  const final = Object.values(merged).sort((a,b) => {
    if (period === 'weekly') {
      if (a._id.year !== b._id.year) return a._id.year - b._id.year;
      return a._id.week - b._id.week;
    } else {
      if (a._id.year !== b._id.year) return a._id.year - b._id.year;
      return a._id.month - b._id.month;
    }
  });

  return final.slice(0, 12);
};

export const getUnassignedOrders = async (month, year) => {
  const User = (await import('../user/user.model.js')).default;
  const Order = (await import('../shiprocket/models/order.model.js')).Order;
  const ShipmaxxOrder = (await import('../shipmaxx/models/shipmaxxOrder.model.js')).ShipmaxxOrder;
  const allUsers = await User.find({ role: { $in: ['sales', 'manager', 'staff', 'support', 'logistics'] }, isDeleted: false }).select('_id role').lean();
  const allUserIds = new Set(allUsers.map(u => String(u._id)));
  
  const IST_OFFSET = 5.5 * 60 * 60 * 1000;
  const monthStart = new Date(Date.UTC(year, month, 1) - IST_OFFSET);
  const monthEnd = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999) - IST_OFFSET);

  const allOrders = await getSynchronizedDeliveredOrders(monthStart, monthEnd, Order, ShipmaxxOrder, true);
  const unassigned = [];
  
  for (const o of allOrders) {
    let uid = null;
    const taskCreatedBy = o.task_created_by ? (o.task_created_by._id ? String(o.task_created_by._id) : String(o.task_created_by)) : null;
    const verifiedBy = o.verified_by ? (o.verified_by._id ? String(o.verified_by._id) : String(o.verified_by)) : null;
    const createdBy = o.created_by ? (o.created_by._id ? String(o.created_by._id) : String(o.created_by)) : null;
    const leadOwner = o.lead_id && typeof o.lead_id === 'object' && o.lead_id.assignedTo
      ? (o.lead_id.assignedTo._id ? String(o.lead_id.assignedTo._id) : String(o.lead_id.assignedTo))
      : null;
    
    if (o.source_order_id) {
      uid = verifiedBy || createdBy;
    } else {
      uid = taskCreatedBy || verifiedBy || leadOwner || createdBy;
    }
    
    if (!uid || !allUserIds.has(uid)) {
      unassigned.push({
        _id: o._id,
        platform: o.platform || (o.shiprocket_order_id ? 'shiprocket' : 'shipmaxx'),
        billing_customer_name: o.billing_customer_name,
        sub_total: o.sub_total || o.total,
        order_date: o.createdAt,
        delivered_at: o.delivered_at || o.status_updated_at,
        created_by_name: o.created_by?.name || 'Unknown',
        tracking_id: o.awb_code
      });
    }
  }
  
  return unassigned.sort((a,b) => new Date(b.delivered_at) - new Date(a.delivered_at));
};

export const assignOrder = async (orderId, staffId, platform) => {
  const User = (await import('../user/user.model.js')).default;
  const staff = await User.findById(staffId);
  if (!staff) throw new Error('Staff not found');

  let OrderModel;
  if (platform === 'shipmaxx') {
    OrderModel = (await import('../shipmaxx/models/shipmaxxOrder.model.js')).ShipmaxxOrder;
  } else {
    OrderModel = (await import('../shiprocket/models/order.model.js')).Order;
  }

  const order = await OrderModel.findById(orderId);
  if (!order) throw new Error('Order not found');

  // Assign by changing created_by to the staff member so it counts for them
  // (We enforce role=sales to get manual order credit, so staff must be sales)
  order.created_by = staffId;
  await order.save();
  return { success: true };
};


export const getStaffDeliveryStats = async (month, year, filterUserId = null, from = null, to = null, preset = null) => {
  const User = (await import('../user/user.model.js')).default;
  const Lead = (await import('../lead/lead.model.js')).default;
  const { Order } = await import('../shiprocket/models/order.model.js');
  const { ShipmaxxOrder } = await import('../shipmaxx/models/shipmaxxOrder.model.js');
  const FollowupCommissionSettings = (await import('../commission/followupCommissionSettings.model.js')).default;
  let reorderSettings = await FollowupCommissionSettings.findOne().sort({ createdAt: -1 }).lean();
  if (!reorderSettings) {
    reorderSettings = { reorder_commission_amount: 0, reorder_commission_percent: 0, commission_type: 'flat' };
  }

  const { isAllTime, start: monthStart, end: monthEnd } = buildStatsDateRange(preset, from, to);

  const allUsers = await User.find({ role: { $in: ['sales', 'support'] }, isDeleted: false })
    .select('_id name role commissionRate').lean();

  const statsMap = {};
  for (const u of allUsers) {
    statsMap[String(u._id)] = { user: u, delivered: 0, newDelivered: 0, oldDelivered: 0, supportOldDelivered: 0, rto: 0 };
  }

  // RTO lookback: 45 days (1 month 15 days) from the end of the period
  const rtoLookbackStart = isAllTime ? null : new Date(monthEnd.getTime() - 45 * 24 * 60 * 60 * 1000);
  const rtoTimeFilter = isAllTime ? {} : {
    createdAt: { $gte: rtoLookbackStart, $lte: monthEnd }
  };

  const [synchronizedDelivered, rtoOrdersSM, rtoOrdersSR] = await Promise.all([
    getSynchronizedDeliveredOrders(monthStart, monthEnd, Order, ShipmaxxOrder, false),
    ShipmaxxOrder.find({ status: { $regex: /^(rto|rra)/i }, ...rtoTimeFilter })
      .select('_id lead_id createdAt source_order_id task_created_by verified_by created_by awb_code order_id').lean(),
    Order.find({ status: { $regex: /^(rto|rra)/i }, ...rtoTimeFilter })
      .select('_id lead_id createdAt source_order_id task_created_by verified_by created_by awb_code order_id').lean(),
  ]);

  const allOrders = [
    ...synchronizedDelivered.map(o => ({ ...o, type: 'delivered' })),
    ...rtoOrdersSM.map(o => ({ ...o, type: 'rto' })),
    ...rtoOrdersSR.map(o => ({ ...o, type: 'rto' })),
  ];

  if (allOrders.length === 0) {
    if (filterUserId) return { delivered: 0, newDelivered: 0, oldDelivered: 0, supportOldDelivered: 0, rto: 0, deliveredOrders: [], newDeliveredOrders: [], oldDeliveredOrders: [], rtoOrders: [] };
    return { staff: [], unassignedDelivered: 0, unassignedRto: 0, totalDelivered: 0, totalRto: 0 };
  }

  const allLeadIds = [...new Set(allOrders.map(o => o.lead_id).filter(Boolean).map(String))];
  
  const leadAssignMap = {};
  if (allLeadIds.length > 0) {
    const leadDocs = await Lead.find({ _id: { $in: allLeadIds } }).select('_id assignedTo').lean();
    for (const l of leadDocs) leadAssignMap[String(l._id)] = String(l.assignedTo);
  }

  let unassignedDelivered = 0;
  let unassignedRto = 0;

  const { phoneToSales, leadMap: histLeadMap } = await getPhoneToSalesAgentMap(Order, ShipmaxxOrder, Lead, statsMap, allOrders);

  for (const o of allOrders) {
    const lId = o.lead_id ? String(o.lead_id) : null;
    const leadOwner = lId ? (leadAssignMap[lId] || null) : null;
    const tId = o.task_created_by ? String(o.task_created_by) : null;
    const vId = o.verified_by ? String(o.verified_by) : null;
    const cId = o.created_by ? String(o.created_by) : null;

    if (o.type === 'rto') {
      const lUid = o.lead_id ? String(leadAssignMap[String(o.lead_id)] || '') : null;
      const cId = o.created_by ? String(o.created_by) : null;
      let uid = lUid;
      if (!uid && cId && statsMap[cId] && statsMap[cId].user.role === 'sales') uid = cId;
      
      if (uid && statsMap[uid]) statsMap[uid].rto++;
      else unassignedRto++;
      continue;
    }

    const phone = (o.billing_phone || (o.lead_id && (typeof o.lead_id === 'object' ? o.lead_id.phone : (histLeadMap[String(o.lead_id)]?.phone || ''))))?.replace(/\D/g, '').slice(-10);
    const isOld = Boolean(o.source_order_id);
    let handled = false;

    if (!isOld) {
      const candidates = [tId, leadOwner, vId, cId].filter(Boolean);
      for (const cand of candidates) {
        if (statsMap[cand]) {
          if (statsMap[cand].user.role === 'support') {
            statsMap[cand].supportOldDelivered++;
            statsMap[cand].oldDelivered++;
            statsMap[cand].delivered++;
            if (phone && phoneToSales[phone] && statsMap[phoneToSales[phone]]) {
              statsMap[phoneToSales[phone]].newDelivered++;
              statsMap[phoneToSales[phone]].delivered++;
            }
          } else {
            statsMap[cand].newDelivered++;
            statsMap[cand].delivered++;
          }
          handled = true;
          break;
        }
      }
    } else {
      const supportCand = [vId, cId, leadOwner].filter(Boolean);
      for (const cand of supportCand) {
        if (statsMap[cand] && statsMap[cand].user.role === 'support') {
          statsMap[cand].supportOldDelivered++;
          statsMap[cand].oldDelivered++;
          statsMap[cand].delivered++;
          handled = true;
          break;
        }
      }
      if (phone && phoneToSales[phone] && statsMap[phoneToSales[phone]]) {
        statsMap[phoneToSales[phone]].oldDelivered++;
        statsMap[phoneToSales[phone]].delivered++;
        handled = true;
      }
    }
    if (!handled) unassignedDelivered++;
  }

  // If personal request — return only this user's stats + order lists
  if (filterUserId) {
    const me = statsMap[String(filterUserId)];
    if (!me) return { delivered: 0, newDelivered: 0, oldDelivered: 0, supportOldDelivered: 0, rto: 0, deliveredOrders: [], newDeliveredOrders: [], oldDeliveredOrders: [], rtoOrders: [] };

    const myDeliveredIds = new Set();
    const myNewDeliveredIds = new Set();
    const myOldDeliveredIds = new Set();
    const myRtoIds = new Set();
    const strUserId = String(filterUserId);

    for (const o of allOrders) {
      const lId = o.lead_id ? String(o.lead_id) : null;
      const leadOwner = lId ? (leadAssignMap[lId] || null) : null;
      const tId = o.task_created_by ? String(o.task_created_by) : null;
      const vId = o.verified_by ? String(o.verified_by) : null;
      const cId = o.created_by ? String(o.created_by) : null;

      if (o.type === 'rto') {
        const lUid = o.lead_id ? String(leadAssignMap[String(o.lead_id)] || '') : null;
        const cId = o.created_by ? String(o.created_by) : null;
        let uid = lUid;
        if (!uid && cId && statsMap[cId] && statsMap[cId].user.role === 'sales') uid = cId;
        
        if (uid === strUserId) myRtoIds.add(String(o._id));
        continue;
      }

      const phone = (o.billing_phone || (o.lead_id && (typeof o.lead_id === 'object' ? o.lead_id.phone : (histLeadMap[String(o.lead_id)]?.phone || ''))))?.replace(/\D/g, '').slice(-10);
      const isOld = Boolean(o.source_order_id);

      if (!isOld) {
        const candidates = [tId, leadOwner, vId, cId].filter(Boolean);
        for (const cand of candidates) {
          if (statsMap[cand]) {
            if (cand === strUserId) {
              myDeliveredIds.add(String(o._id));
              if (me.user.role === 'support') myOldDeliveredIds.add(String(o._id));
              else myNewDeliveredIds.add(String(o._id));
            } else if (statsMap[cand].user.role === 'support' && phone && phoneToSales[phone] === strUserId) {
              myDeliveredIds.add(String(o._id));
              myNewDeliveredIds.add(String(o._id));
            }
            break;
          }
        }
      } else {
        if (me.user.role === 'support') {
          const supportCand = [vId, cId, leadOwner].filter(Boolean);
          for (const cand of supportCand) {
            if (statsMap[cand] && statsMap[cand].user.role === 'support') {
              if (cand === strUserId) {
                myOldDeliveredIds.add(String(o._id));
                myDeliveredIds.add(String(o._id));
              }
              break;
            }
          }
        } else {
          if (phone && phoneToSales[phone] === strUserId) {
            myOldDeliveredIds.add(String(o._id));
            myDeliveredIds.add(String(o._id));
          }
        }
      }
    }

    // Fetch full details for these orders
    const allIds = [...myDeliveredIds, ...myRtoIds];
    const ReorderCommission = (await import('../commission/reorderCommission.model.js')).default;
    const commissions = await ReorderCommission.find({ order_id: { $in: allIds }, staff_id: strUserId }).lean();
    const commissionMap = {};
    for (const c of commissions) commissionMap[String(c.order_id)] = c.commission_amount;

    const [smFull, srFull] = await Promise.all([
      ShipmaxxOrder.find({ _id: { $in: allIds } })
        .select('_id billing_customer_name billing_phone awb_code sub_total total status delivered_at createdAt lead_id')
        .populate('lead_id', 'name phone')
        .lean(),
      Order.find({ _id: { $in: allIds } })
        .select('_id billing_customer_name billing_phone awb_code sub_total total status delivered_at createdAt lead_id')
        .populate('lead_id', 'name phone')
        .lean(),
    ]);

    const formatOrder = (o) => {
      let comm = commissionMap[String(o._id)];
      
      // If no explicit commission record exists, calculate dynamically
      if (comm === undefined) {
        comm = 0;
        const amt = Number(o.sub_total) || Number(o.total) || 0;
        if (myNewDeliveredIds.has(String(o._id))) {
          if (me.user.role === 'support') {
            comm = 50;
          } else {
            comm = Math.round(amt * ((me.user.commissionRate ?? 5) / 100));
          }
        } else if (myOldDeliveredIds.has(String(o._id))) {
          // Dynamic calculation for Repeat / Re-Ver
          const isOriginal = (me.user.role === 'sales'); 
          
          const slab = (reorderSettings.price_slabs || []).find(s =>
            amt >= s.min_price && (s.max_price === null || s.max_price === undefined || amt <= s.max_price)
          );
          const src = slab || reorderSettings;
          
          if (reorderSettings.commission_type === 'percent') {
            const pct = isOriginal ? src.original_staff_commission_percent : src.reorder_commission_percent;
            comm = Math.round((amt * (pct || 0)) / 100);
          } else {
            comm = isOriginal ? src.original_staff_commission_amount : src.reorder_commission_amount;
          }
        }
      }
      
      return {
        _id: o._id,
        name: o.lead_id?.name || o.billing_customer_name || '—',
        phone: o.lead_id?.phone || o.billing_phone || '—',
        awb: o.awb_code || '—',
        amount: Number(o.sub_total) || Number(o.total) || 0,
        status: o.status,
        date: o.delivered_at || o.createdAt,
        commission: comm
      };
    };

    const allFull = [...smFull, ...srFull];
    const deliveredOrders = allFull.filter(o => myDeliveredIds.has(String(o._id))).map(formatOrder)
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    const newDeliveredOrders = allFull.filter(o => myNewDeliveredIds.has(String(o._id))).map(formatOrder)
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    const oldDeliveredOrders = allFull.filter(o => myOldDeliveredIds.has(String(o._id))).map(formatOrder)
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    const rtoOrders = allFull.filter(o => myRtoIds.has(String(o._id))).map(formatOrder)
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    const newCommissionTotal = newDeliveredOrders.reduce((sum, o) => sum + (o.commission || 0), 0);
    const oldCommissionTotal = oldDeliveredOrders.reduce((sum, o) => sum + (o.commission || 0), 0);
    const totalCommission = deliveredOrders.reduce((sum, o) => sum + (o.commission || 0), 0);

    return { 
      delivered: me.delivered, 
      newDelivered: me.newDelivered,
      oldDelivered: me.oldDelivered,
      supportOldDelivered: me.supportOldDelivered,
      rto: me.rto, 
      deliveredOrders, 
      newDeliveredOrders,
      oldDeliveredOrders,
      rtoOrders,
      newCommissionTotal,
      oldCommissionTotal,
      totalCommission
    };
  }

  const staffList = Object.values(statsMap)
    .filter(s => s.delivered > 0 || s.rto > 0)
    .sort((a, b) => (b.delivered + b.rto) - (a.delivered + a.rto));

  const totalDelivered = staffList.reduce((s, x) => s + x.delivered, 0) + unassignedDelivered;
  const totalRto = staffList.reduce((s, x) => s + x.rto, 0) + unassignedRto;

  return { staff: staffList, unassignedDelivered, unassignedRto, totalDelivered, totalRto };
};


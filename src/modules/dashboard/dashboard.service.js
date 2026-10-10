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
    verifiedCount: Math.max(verifiedCount, todayVerifications),
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

export const getStaffTodayLists = async (userRole, userId, targetDate, targetStaffId, from, to, preset, userDepartments = []) => {
  const range = buildStatsDateRange(preset, from, to);
  const isAllTime = range.isAllTime;
  const start = range.start;
  const end = range.end;

  const filter = isAllTime ? {} : { createdAt: { $gte: start, $lte: end } };
  const updateFilter = isAllTime ? {} : { updatedAt: { $gte: start, $lte: end } };
  const taskFilter = { isDeleted: false, ...(isAllTime ? {} : { updatedAt: { $gte: start, $lte: end } }) };

  let sid = null;
  const staffIdToUse = targetStaffId || userId;
  if (staffIdToUse && mongoose.Types.ObjectId.isValid(String(staffIdToUse))) {
    sid = new mongoose.Types.ObjectId(String(staffIdToUse));
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

  const { Order } = await import('../shiprocket/models/order.model.js');
  const { ShipmaxxOrder } = await import('../shipmaxx/models/shipmaxxOrder.model.js');
  const Lead = (await import('../lead/lead.model.js')).default;
  const Task = (await import('../task/task.model.js')).default;

  const orderDateFilter = isAllTime ? {} : { createdAt: { $gte: start, $lte: end } };

  const [cnpList, callAgainList, interestedList, notInterestedList, onHoldList, verificationList, taskList, staffStatsRes] = await Promise.all([
    Cnp.find(updateFilter)
      .populate('lead', 'name phone').populate('assignedTo', 'name').sort({ updatedAt: -1 }).limit(100).lean(),
    CallAgain.find(updateFilter)
      .populate('lead', 'name phone').populate('assignedTo', 'name').sort({ updatedAt: -1 }).limit(100).lean(),
    Task.find({ ...taskFilter, status: 'interested' })
      .populate('lead', 'name phone').sort({ updatedAt: -1 }).limit(100).lean(),
    Task.find({ ...taskFilter, status: 'cancel_call' })
      .populate('lead', 'name phone').sort({ updatedAt: -1 }).limit(100).lean(),
    Verification.find({ ...updateFilter, status: 'on_hold' })
      .populate('lead', 'name phone').sort({ updatedAt: -1 }).limit(100).lean(),
    Verification.find({ ...filter })
      .populate('lead', 'name phone status').sort({ createdAt: -1 }).limit(100).lean(),
    Task.find({ ...taskFilter })
      .populate('lead', 'name phone').sort({ updatedAt: -1 }).limit(100).lean(),
    sid ? getAllStaffStats(targetDate, from, to, preset) : Promise.resolve(null),
  ]);

  let bookedOrders = [];
  if (sid && staffStatsRes && staffStatsRes.staffStats) {
    const foundStaff = staffStatsRes.staffStats.find(s => String(s.user._id) === String(sid));
    if (foundStaff && foundStaff.bookedOrders) {
      bookedOrders = foundStaff.bookedOrders;
    }
  }

  return { cnpList, callAgainList, interestedList, notInterestedList, onHoldList, verificationList, taskList, bookedOrders };
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
  if (preset === 'month' || preset === 'mtd' || fromDate === 'month' || preset === 'this_month') {
    const start = new Date(Date.UTC(y, m, 1) - IST_OFFSET);
    return { isAllTime: false, start: start, end: now };
  }
  if (preset === 'last_month' || preset === 'lastMonth') {
    const start = new Date(Date.UTC(y, m - 1, 1) - IST_OFFSET);
    const end = new Date(Date.UTC(y, m, 0, 23, 59, 59, 999) - IST_OFFSET);
    return { isAllTime: false, start: start, end: end };
  }
  if (preset === 'last7' || preset === 'weekly' || preset === '7d' || fromDate === 'last7') {
    const start = new Date(istNow.getTime() - 7 * 24 * 60 * 60 * 1000);
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
  const { OnHoldOrder } = await import('../transition/statusModels.js');

  const userQuery = { role: { $in: ['sales', 'manager', 'doctor', 'support', 'logistics'] }, isDeleted: false };
  if (requestingUser && ['sales', 'support', 'logistics'].includes(requestingUser.role)) {
    userQuery._id = requestingUser._id;
  }
  const allUsers = await User.find(userQuery).select('_id name phone role').lean();
  
  const statsMap = {};
  for (const u of allUsers) {
    statsMap[String(u._id)] = {
      user: u,
      checkIn: null, checkOut: null, prevCheckOut: null,
      todayVerifications: 0, monthVerifications: 0, pendingTasks: 0, todayTarget: 0,
      todayCnp: 0, todayCallAgain: 0, todayInterested: 0, todayNotInterested: 0, todayClosedLost: 0,
      leadsAdded: 0, tasksAssigned: 0, afterCheckoutLeads: 0, afterCheckoutTasks: 0, verifiedCount: 0, onHoldCount: 0, readyToShipmentCount: 0, deliveredCount: 0,
      rtoCount: 0, monthDispatchedCount: 0, monthDeliveredCount: 0, monthRtoCount: 0,
      assignedVerifications: 0, workingHours: 0, workingPercentage: 0,
      totalAppointments: 0, completedAppointments: 0, cancelledAppointments: 0,
      newDeliveredCount: 0, salesOldDeliveredCount: 0, supportOldDeliveredCount: 0,
      uniqueDeliveredCount: 0, // Counts each physical order exactly once (no dual-attribution inflation)
      commentsCount: 0, cnpComments: 0, callAgainComments: 0, interestedComments: 0,
      ofdCommentsCount: 0, rtoCommentsCount: 0,
      commission: 0,
      bookedOrders: [],
      _noteSet: new Set(), _intSet: new Set(), _cnpSet: new Set(), _caSet: new Set(), _onHoldSet: new Set(),
      _assignedLeadTaskSet: new Set()
    };
  }
  let totalUniqueDelivered = 0; // Grand total of unique delivered orders across all staff

  const queryMinStart = isAllTime ? null : (startOfDay < monthStart ? startOfDay : monthStart);
  const queryMaxEnd = isAllTime ? null : (endOfDay > monthEnd ? endOfDay : monthEnd);

  const yestStart = new Date(startOfDay.getTime() - 24 * 60 * 60 * 1000);

  // 2. Fetch Bulk Data in parallel
  const [
    allAttendances, allAppointments, allTargets, allVerifications, allTasks, 
    allCnps, allCallAgains, allLeadsData, allOrdersSR, allOrdersSM, allCommissions,
    allOnHoldOrders
  ] = await Promise.all([
    Attendance.find({ date: { $gte: yestStart, $lte: endOfDay }, isDeleted: false }).select('user date checkIn checkOut workingHours').lean(),
    Appointment.find({ appointmentDate: { $gte: startOfDay, $lte: endOfDay }, isDeleted: false }).select('doctorName status').lean(),
    StaffTarget.find({ date: { $gte: fromDate || dateStr, $lte: toDate || dateStr } }).lean(),
    Verification.find({ isDeleted: { $ne: true }, ...(isAllTime ? {} : { createdAt: { $gte: queryMinStart, $lte: queryMaxEnd } }) }).select('assignedTo verifiedBy status createdAt updatedAt').lean(),
    Task.find({ 
      ...(isAllTime ? {} : {
        $or: [
          { status: 'pending' }, 
          { createdAt: { $gte: yestStart, $lte: endOfDay } },
          { updatedAt: { $gte: yestStart, $lte: endOfDay } }
        ]
      })
    }).select('lead assignedTo status notes updatedAt createdAt').lean(),
    Cnp.find({ 
      ...(isAllTime ? {} : { 
        $or: [
          { createdAt: { $gte: yestStart, $lte: endOfDay } },
          { updatedAt: { $gte: yestStart, $lte: endOfDay } }
        ]
      }) 
    }).select('assignedTo notes createdAt updatedAt').lean(),
    CallAgain.find({ 
      ...(isAllTime ? {} : { 
        $or: [
          { createdAt: { $gte: yestStart, $lte: endOfDay } },
          { updatedAt: { $gte: yestStart, $lte: endOfDay } }
        ]
      }) 
    }).select('lead assignedTo status notes createdAt updatedAt').lean(),
    Lead.find({ 
      ...(isAllTime ? {} : {
        $or: [
          { createdAt: { $gte: yestStart, $lte: endOfDay } },
          { updatedAt: { $gte: yestStart, $lte: endOfDay } }
        ]
      }) 
    }).select('assignedTo status cnp notes follow_ups createdAt updatedAt').lean(),
    Order.find({ 
      status: { $nin: ['cancelled', 'CANCELLED', 'Cancelled'] },
      ...(isAllTime ? {} : { createdAt: { $gte: queryMinStart, $lte: queryMaxEnd } })
    }).select('comments billing_phone shipping_phone lead_id task_created_by created_by verified_by source_order_id status createdAt updatedAt')
      .populate('lead_id', 'assignedTo')
      .lean(),
    ShipmaxxOrder.find({ 
      status: { $nin: ['cancelled', 'CANCELLED', 'Cancelled'] },
      ...(isAllTime ? {} : { createdAt: { $gte: queryMinStart, $lte: queryMaxEnd } })
    }).select('comments billing_phone shipping_phone lead_id task_created_by created_by verified_by source_order_id status createdAt updatedAt')
      .populate('lead_id', 'assignedTo')
      .lean(),
    ReorderCommission.aggregate([
      { $match: { 
          status: { $in: ['pending', 'paid'] },
          ...(isAllTime ? {} : { createdAt: { $gte: queryMinStart, $lte: queryMaxEnd } }) 
      }},
      { $group: { _id: '$staff_id', totalCommission: { $sum: '$commission_amount' } } }
    ]),
    OnHoldOrder ? OnHoldOrder.find({
      isDeleted: { $ne: true },
      ...(isAllTime ? {} : { updatedAt: { $gte: yestStart, $lte: queryMaxEnd } })
    }).select('assignedTo created_by task_created_by updatedAt createdAt').lean() : Promise.resolve([])
  ]);

  // Build Phone-to-Staff mapping across Lead, Task, and Verification to match unlinked orders by customer phone number
  const phoneToStaffMap = new Map();
  const userRoleMap = {};
  allUsers.forEach(u => { userRoleMap[String(u._id)] = u.role; });

  const addPhoneToMap = (phone, ...candidateIds) => {
    if (!phone) return;
    const p = String(phone).replace(/\D/g, '').slice(-10);
    if (p.length !== 10) return;
    for (const cand of candidateIds) {
      if (!cand) continue;
      const cid = String(cand._id || cand);
      const role = userRoleMap[cid];
      if (role === 'sales' || role === 'support') {
        if (!phoneToStaffMap.has(p) || userRoleMap[phoneToStaffMap.get(p)] !== 'sales') {
          phoneToStaffMap.set(p, cid);
          if (role === 'sales') break;
        }
      }
    }
  };

  const targetPhones = new Set();
  [...allOrdersSR, ...allOrdersSM].forEach(o => {
    const p1 = String(o.billing_phone || '').replace(/\D/g, '').slice(-10);
    const p2 = String(o.shipping_phone || '').replace(/\D/g, '').slice(-10);
    if (p1.length === 10) targetPhones.add(p1);
    if (p2.length === 10) targetPhones.add(p2);
  });
  const phoneArray = Array.from(targetPhones);

  const [allLeadsPhone, allTasksPhone, allVerifsPhone] = await Promise.all([
    phoneArray.length ? Lead.find({ isDeleted: false, $or: [{ phone: { $in: phoneArray } }, { mobile: { $in: phoneArray } }] }).select('phone mobile assignedTo createdBy changedBy').lean() : [],
    phoneArray.length ? Task.find({ isDeleted: false, $or: [{ phone: { $in: phoneArray } }, { mobile: { $in: phoneArray } }] }).select('phone mobile assignedTo createdBy changedBy').lean() : [],
    phoneArray.length ? Verification.find({ isDeleted: { $ne: true }, $or: [{ phone: { $in: phoneArray } }, { mobile: { $in: phoneArray } }] }).select('phone mobile assignedTo verifiedBy changedBy').lean() : [],
  ]);

  for (const l of allLeadsPhone) addPhoneToMap(l.phone || l.mobile, l.assignedTo, l.changedBy, l.createdBy);
  for (const t of allTasksPhone) addPhoneToMap(t.phone || t.mobile, t.assignedTo, t.changedBy, t.createdBy);
  for (const v of allVerifsPhone) addPhoneToMap(v.phone || v.mobile, v.verifiedBy, v.assignedTo, v.changedBy);

  // Process Commissions
  for (const c of allCommissions) {
    const uid = String(c._id);
    if (statsMap[uid]) {
      statsMap[uid].commission = c.totalCommission || 0;
    }
  }

  // Process Attendances FIRST to establish checkIn/checkOut boundaries for shift-based counting
  const attendanceByDateMap = new Map();
  for (const a of allAttendances) {
    const uid = String(a.user);
    if (statsMap[uid]) {
      if (a.date) {
        const dObj = new Date(a.date);
        const istDateStr = new Date(dObj.getTime() + IST_OFFSET).toISOString().slice(0, 10);
        attendanceByDateMap.set(`${uid}_${istDateStr}`, a);
      }
      const aTime = new Date(a.date).getTime();
      if (aTime < startOfDay.getTime()) {
        if (a.checkOut) statsMap[uid].prevCheckOut = a.checkOut;
      } else {
        let liveHours = 0;
        if (a.checkIn && !a.checkOut) liveHours = (Date.now() - new Date(a.checkIn).getTime()) / (1000 * 60 * 60);
        statsMap[uid].workingHours += (a.workingHours || 0) + liveHours;
        if (a.checkIn) statsMap[uid].checkIn = a.checkIn;
        if (a.checkOut) statsMap[uid].checkOut = a.checkOut;
      }
    }
  }

  // Finalize attendance workingPercentage and doctor appointments
  for (const uid in statsMap) {
    const expectedHours = 9;
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

  // Helper for Post-Checkout & Overnight assignments across any preset
  const isAfterCheckout = (date, uid = null) => {
    if (isAllTime || !date || !uid || !statsMap[uid]) return false;
    const dTime = new Date(date).getTime();
    if (isNaN(dTime)) return false;
    if (dTime < startOfDay.getTime() || dTime > endOfDay.getTime()) return false;

    const istDateStr = new Date(dTime + IST_OFFSET).toISOString().slice(0, 10);
    const todayAtt = attendanceByDateMap.get(`${uid}_${istDateStr}`);

    if (todayAtt && todayAtt.checkOut) {
      const coTime = new Date(todayAtt.checkOut).getTime();
      if (dTime > coTime) return true;
    }

    const prevDateObj = new Date(dTime - 24 * 60 * 60 * 1000);
    const prevIstDateStr = new Date(prevDateObj.getTime() + IST_OFFSET).toISOString().slice(0, 10);
    const prevAtt = attendanceByDateMap.get(`${uid}_${prevIstDateStr}`);

    if (prevAtt && prevAtt.checkOut && todayAtt && todayAtt.checkIn) {
      const prevCoTime = new Date(prevAtt.checkOut).getTime();
      const ciTime = new Date(todayAtt.checkIn).getTime();
      if (dTime >= prevCoTime && dTime < ciTime) return true;
    }

    if (!todayAtt && statsMap[uid].checkOut && (!preset || preset === 'today')) {
      const coTime = new Date(statsMap[uid].checkOut).getTime();
      if (dTime > coTime) return true;
    }

    return false;
  };

  // Helper to check date range & shift boundaries
  const isToday = (date, uid = null, checkShiftBoundary = false) => {
    if (isAllTime) return true;
    if (!date) return false;
    const dTime = new Date(date).getTime();
    if (isNaN(dTime)) return false;
    if (dTime < startOfDay.getTime() || dTime > endOfDay.getTime()) return false;
    if (checkShiftBoundary && uid && isAfterCheckout(date, uid)) {
      return false;
    }
    return true;
  };

  // Helper to check shift boundary (Yesterday Checkout -> Today Checkout or Live Now)
  const isActionInShiftWindow = (date, uid) => {
    if (isAllTime) return true;
    if (!date) return false;
    const dTime = new Date(date).getTime();
    if (isNaN(dTime)) return false;

    const isCustomRange = fromDate && toDate && fromDate !== 'all' && toDate !== 'all' && preset !== 'today';
    if (isCustomRange) {
      return dTime >= startOfDay.getTime() && dTime <= endOfDay.getTime();
    }

    if (!uid || !statsMap[uid]) {
      return dTime >= startOfDay.getTime() && dTime <= endOfDay.getTime();
    }

    let shiftStart = statsMap[uid].prevCheckOut
      ? new Date(statsMap[uid].prevCheckOut).getTime()
      : startOfDay.getTime() - 5 * 60 * 60 * 1000;

    let shiftEnd = statsMap[uid].checkOut
      ? new Date(statsMap[uid].checkOut).getTime()
      : Date.now();

    return dTime >= shiftStart && dTime <= shiftEnd;
  };

  const isMonth = (date) => new Date(date) >= monthStart && new Date(date) <= monthEnd;

  const addOnHold = (uid, idStr) => {
    if (!uid || !statsMap[uid]) return;
    if (!statsMap[uid]._onHoldSet) statsMap[uid]._onHoldSet = new Set();
    if (!statsMap[uid]._onHoldSet.has(idStr)) {
      statsMap[uid]._onHoldSet.add(idStr);
      statsMap[uid].onHoldCount++;
    }
  };

  // Process OnHoldOrder collection
  if (Array.isArray(allOnHoldOrders)) {
    for (const oh of allOnHoldOrders) {
      const uid = String(oh.assignedTo || oh.task_created_by || oh.created_by || '');
      if (uid && statsMap[uid] && (isActionInShiftWindow(oh.updatedAt, uid) || isActionInShiftWindow(oh.createdAt, uid))) {
        addOnHold(uid, String(oh._id));
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
    const assignUid = v.assignedTo ? String(v.assignedTo) : null;
    const verifyUid = v.verifiedBy ? String(v.verifiedBy) : null;
    
    if (assignUid && statsMap[assignUid] && ['sales', 'support'].includes(statsMap[assignUid].user.role)) {
      statsMap[assignUid].assignedVerifications++;
      if (isActionInShiftWindow(v.createdAt, assignUid)) {
        statsMap[assignUid].todayVerifications++;
      }
      if (isMonth(v.createdAt)) statsMap[assignUid].monthVerifications++;
    }
    if (verifyUid && verifyUid !== assignUid && statsMap[verifyUid] && ['sales', 'support'].includes(statsMap[verifyUid].user.role)) {
      if (isActionInShiftWindow(v.createdAt, verifyUid)) {
        statsMap[verifyUid].todayVerifications++;
      }
    }
    if (v.status === 'on_hold' && (isActionInShiftWindow(v.updatedAt, assignUid || verifyUid) || isActionInShiftWindow(v.createdAt, assignUid || verifyUid))) {
      addOnHold(assignUid || verifyUid, String(v._id));
    }
  }

  const addNoteStats = (uid, n, cat) => {
    if (!statsMap[uid] || !isActionInShiftWindow(n.createdAt, uid)) return;
    const key = `${new Date(n.createdAt).getTime()}_${(n.text || '').trim()}`;
    if (!statsMap[uid]._noteSet.has(key)) {
      statsMap[uid]._noteSet.add(key);
      statsMap[uid].commentsCount++;
      if (cat === 'cnp') statsMap[uid].cnpComments++;
      else if (cat === 'call_again') statsMap[uid].callAgainComments++;
      else if (cat === 'interested') statsMap[uid].interestedComments++;
    }
  };

  // Process Cnp
  for (const c of allCnps) {
    const uid = String(c.assignedTo || '');
    if (statsMap[uid] && ['sales', 'support'].includes(statsMap[uid].user.role) && (isActionInShiftWindow(c.updatedAt, uid) || isActionInShiftWindow(c.createdAt, uid))) {
      if (!statsMap[uid]._cnpSet) statsMap[uid]._cnpSet = new Set();
      statsMap[uid]._cnpSet.add(String(c._id));
    }
    if (c.notes && c.notes.length) {
      for (const n of c.notes) addNoteStats(n.createdBy ? String(n.createdBy) : uid, n, 'cnp');
    }
  }

  // Process CallAgain
  for (const ca of allCallAgains) {
    const uid = String(ca.assignedTo || '');
    if (statsMap[uid] && ['sales', 'support'].includes(statsMap[uid].user.role) && (isActionInShiftWindow(ca.updatedAt, uid) || isActionInShiftWindow(ca.createdAt, uid))) {
      if (!statsMap[uid]._caSet) statsMap[uid]._caSet = new Set();
      statsMap[uid]._caSet.add(String(ca._id));
    }
    if (ca.notes && ca.notes.length) {
      for (const n of ca.notes) addNoteStats(n.createdBy ? String(n.createdBy) : uid, n, ca.status === 'interested' ? 'interested' : 'call_again');
    }
  }

  // Process Tasks
  for (const t of allTasks) {
    const uid = String(t.assignedTo || '');
    if (statsMap[uid] && statsMap[uid].user.role !== 'doctor') {
      if (t.status === 'pending' || !t.status) {
        statsMap[uid].pendingTasks++;
      }
      const isAssignedInRange = isActionInShiftWindow(t.createdAt, uid);
      if (['sales', 'support', 'logistics', 'manager'].includes(statsMap[uid].user.role)) {
        if (isAssignedInRange) {
          statsMap[uid].tasksAssigned++;

          // Categorize status for shift assigned tasks to guarantee 100% mathematical consistency
          const st = String(t.status || 'pending').toLowerCase();
          if (st === 'cnp') {
            statsMap[uid].todayCnp++;
          } else if (['call_again', 'follow_up'].includes(st)) {
            statsMap[uid].todayCallAgain++;
          } else if (['verified', 'completed', 'verification', 'ready_to_shipment', 'dispatch', 'dispatched'].includes(st)) {
            statsMap[uid].verifiedCount++;
          } else if (['not_interested', 'cancel_call', 'closed_lost', 'cancelled'].includes(st)) {
            statsMap[uid].todayNotInterested++;
          } else if (st === 'interested') {
            statsMap[uid].todayInterested++;
          }
        }
        if (isAfterCheckout(t.createdAt, uid)) {
          statsMap[uid].afterCheckoutTasks++;
        }
      }
      if (t.status === 'on_hold' && (isActionInShiftWindow(t.updatedAt, uid) || isActionInShiftWindow(t.createdAt, uid))) {
        addOnHold(uid, String(t._id));
      }
    }
    if (t.notes && t.notes.length) {
      const isInterestedToday = t.status === 'interested' && isActionInShiftWindow(t.updatedAt, uid);
      for (const n of t.notes) {
        addNoteStats(n.createdBy ? String(n.createdBy) : uid, n, isInterestedToday ? 'interested' : 'other');
      }
    }
  }

  // Combine Cnp and CallAgain action logs so all calls made in shift are accurately captured
  for (const uid in statsMap) {
    if (statsMap[uid]._cnpSet && statsMap[uid]._cnpSet.size > 0) {
      statsMap[uid].todayCnp = Math.max(statsMap[uid].todayCnp, statsMap[uid]._cnpSet.size);
    }
    if (statsMap[uid]._caSet && statsMap[uid]._caSet.size > 0) {
      statsMap[uid].todayCallAgain = Math.max(statsMap[uid].todayCallAgain, statsMap[uid]._caSet.size);
    }
    if (statsMap[uid].todayVerifications > 0) {
      statsMap[uid].verifiedCount = Math.max(statsMap[uid].verifiedCount, statsMap[uid].todayVerifications);
    }
  }

  // Process Leads (Strict calendar date assignment tracking - Sales only)
  for (const l of allLeadsData) {
    const uid = String(l.assignedTo || '');
    if (statsMap[uid] && statsMap[uid].user.role !== 'doctor') {
      if (statsMap[uid].user.role === 'sales') {
        if (isAllTime || isToday(l.createdAt, uid)) {
          statsMap[uid].leadsAdded++;
        }
        if (isAfterCheckout(l.createdAt, uid)) {
          statsMap[uid].afterCheckoutLeads++;
        }
      }
      if (isToday(l.updatedAt, uid) || isToday(l.createdAt, uid)) {
        if (l.status === 'closed_lost') statsMap[uid].todayClosedLost++;
        if (l.status === 'on_hold') {
          addOnHold(uid, String(l._id));
        }
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

  // Deduplicated Order Booking Attribution
  const globalBookedSet = new Set();
  const getCleanIdStr = (id) => id ? String(id._id || id).replace(/^(lead_|task_)/, '') : null;

  const processOrder = (o) => {
    const taskUser = o.task_created_by ? String(o.task_created_by._id || o.task_created_by) : null;
    const leadUser = o.lead_id && typeof o.lead_id === 'object' && o.lead_id.assignedTo ? String(o.lead_id.assignedTo._id || o.lead_id.assignedTo) : null;
    const createdUser = o.created_by ? String(o.created_by._id || o.created_by) : null;
    const verifiedUser = o.verified_by ? String(o.verified_by._id || o.verified_by) : null;
    const isOldOrder = Boolean(o.source_order_id);

    // Phone-based matching for unlinked orders
    const oPhone = String(o.billing_phone || o.shipping_phone || '').replace(/\D/g, '').slice(-10);
    const phoneUser = (oPhone.length === 10 && phoneToStaffMap.has(oPhone)) ? phoneToStaffMap.get(oPhone) : null;

    if (isToday(o.createdAt)) {
      const orderKey = getCleanIdStr(o._id);
      const leadKey = getCleanIdStr(o.lead_id);

      const isAlreadyCounted = (orderKey && globalBookedSet.has(orderKey)) || (leadKey && globalBookedSet.has(leadKey));
      if (!isAlreadyCounted) {
        if (orderKey) globalBookedSet.add(orderKey);
        if (leadKey) globalBookedSet.add(leadKey);

        let uid = null;
        const candList = [
          leadUser, 
          phoneUser,
          verifiedUser, 
          createdUser, 
          taskUser, 
          o.support_staff ? String(o.support_staff._id || o.support_staff) : null
        ].filter(Boolean);

        if (isOldOrder) {
          // Re-order (2nd+ kit): Attribute to Support who re-verified it, then Sales
          for (const cand of candList) {
            if (statsMap[cand] && statsMap[cand].user.role === 'support') {
              uid = cand;
              break;
            }
          }
          if (!uid) {
            for (const cand of candList) {
              if (statsMap[cand] && statsMap[cand].user.role === 'sales') {
                uid = cand;
                break;
              }
            }
          }
        } else {
          // New order (1st kit): Attribute to Sales who generated/owns the lead, then Support
          for (const cand of candList) {
            if (statsMap[cand] && statsMap[cand].user.role === 'sales') {
              uid = cand;
              break;
            }
          }
          if (!uid) {
            for (const cand of candList) {
              if (statsMap[cand] && statsMap[cand].user.role === 'support') {
                uid = cand;
                break;
              }
            }
          }
        }

        if (uid && statsMap[uid] && ['sales', 'support'].includes(statsMap[uid].user.role)) {
          statsMap[uid].readyToShipmentCount++;
          if (!statsMap[uid].bookedOrders) statsMap[uid].bookedOrders = [];
          statsMap[uid].bookedOrders.push({
            _id: o._id,
            order_id: o.order_id || o.awb_code || (o._id ? String(o._id).slice(-6) : ''),
            customer_name: o.billing_customer_name || o.shipping_customer_name || (o.lead_id && typeof o.lead_id === 'object' ? o.lead_id.name : null) || 'Customer',
            phone: o.billing_phone || o.shipping_phone || (o.lead_id && typeof o.lead_id === 'object' ? o.lead_id.phone : null) || '',
            sub_total: o.sub_total || o.total || o.price || 0,
            platform: o.platform || 'shipmaxx',
            status: o.status || 'NEW',
            createdAt: o.createdAt || o.updatedAt || new Date()
          });
        }
      }
    }

    if (isMonth(o.createdAt)) {
      const candidates = [leadUser, verifiedUser, createdUser, taskUser].filter(Boolean);
      let dispUid = null;
      for (const cand of candidates) {
        if (statsMap[cand] && ['sales', 'support'].includes(statsMap[cand].user.role)) {
          dispUid = cand;
          break;
        }
      }
      if (dispUid && statsMap[dispUid]) {
        statsMap[dispUid].monthDispatchedCount++;
      }
    }
  };

  for (const o of allOrdersSR) processOrder(o);
  for (const o of allOrdersSM) processOrder(o);


  const ofdRegex = /^(out_for_delivery|ofd|undelivered|undelivered_attempt_failure|ndr)$/i;
  const rtoRegex = /^(rto|rto_verification|rto_delivered|rto_in_transit|rra)$/i;

  const processOrderComments = (orders) => {
    for (const o of orders) {
      if (o.comments && o.comments.length) {
        for (const c of o.comments) {
          const uid = c.createdBy ? String(c.createdBy._id || c.createdBy) : null;
          if (uid && statsMap[uid] && isToday(c.createdAt)) {
            const sec = (c.section || '').trim();
            const st = (o.status || '').trim();

            if (rtoRegex.test(sec) || rtoRegex.test(st) || sec.toUpperCase().includes('RTO')) {
              statsMap[uid].rtoCommentsCount++;
            } else if (ofdRegex.test(sec) || ofdRegex.test(st) || sec.toUpperCase().includes('DELIVERY') || sec.toUpperCase().includes('UNDELIVERED')) {
              statsMap[uid].ofdCommentsCount++;
            } else {
              statsMap[uid].ofdCommentsCount++;
            }
          }
        }
      }
    }
  };

  processOrderComments(allOrdersSR);
  processOrderComments(allOrdersSM);

  const synchronizedDeliveries = await getSynchronizedDeliveredOrders(isAllTime ? null : startOfDay, isAllTime ? null : endOfDay, Order, ShipmaxxOrder, true);
  
  // RTO lookback: 45 days (1 month 15 days) from the end of the period
  const rtoLookbackStart = isAllTime ? null : new Date(endOfDay.getTime() - 45 * 24 * 60 * 60 * 1000);
  const rtoTimeFilter = isAllTime ? {} : {
    createdAt: { $gte: rtoLookbackStart, $lte: endOfDay }
  };

  const rtoStatusList = ['rto', 'RTO', 'rra', 'RRA', 'rto_verification', 'RTO_VERIFICATION', 'rto_delivered', 'RTO_DELIVERED', 'rto_in_transit', 'RTO_IN_TRANSIT'];
  const [rtoOrdersSM, rtoOrdersSR] = await Promise.all([
    ShipmaxxOrder.find({ status: { $in: rtoStatusList }, ...rtoTimeFilter })
      .select('_id lead_id createdAt source_order_id task_created_by verified_by created_by')
      .populate('lead_id', 'assignedTo')
      .lean(),
    Order.find({ status: { $in: rtoStatusList }, ...rtoTimeFilter })
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
      // New order (first kit) — attribute to lead owner (Sales) or Support
      const candidates = [tId, lId, vId, cId].filter(Boolean);
      for (const cand of candidates) {
        if (statsMap[cand]) {
          if (statsMap[cand].user.role === 'support') {
            // Support handled a new order — counts as Support's re-verification delivery
            statsMap[cand].supportOldDeliveredCount++;
            statsMap[cand].deliveredCount++;
            if (!uniqueCountedForStaff) {
              statsMap[cand].uniqueDeliveredCount++;
              uniqueCountedForStaff = cand;
            }
            // Also credit the original Sales agent (dual attribution - does NOT inflate unique count)
            if (phone && phoneToSales[phone] && statsMap[phoneToSales[phone]] && statsMap[phoneToSales[phone]].user.role === 'sales') {
              statsMap[phoneToSales[phone]].newDeliveredCount++;
              statsMap[phoneToSales[phone]].deliveredCount++;
            }
            break;
          } else if (statsMap[cand].user.role === 'sales') {
            // Sales staff owns this lead — 1st kit delivery
            statsMap[cand].newDeliveredCount++;
            statsMap[cand].deliveredCount++;
            if (!uniqueCountedForStaff) {
              statsMap[cand].uniqueDeliveredCount++;
              uniqueCountedForStaff = cand;
            }
            break;
          }
        }
      }
      // Fallback: If no candidate was Sales/Support (e.g. verified/created by Manager/Logistics), credit original Sales agent via phoneToSales
      if (!uniqueCountedForStaff && phone && phoneToSales[phone] && statsMap[phoneToSales[phone]]) {
        if (statsMap[phoneToSales[phone]].user.role === 'sales') {
          statsMap[phoneToSales[phone]].newDeliveredCount++;
          statsMap[phoneToSales[phone]].deliveredCount++;
          statsMap[phoneToSales[phone]].uniqueDeliveredCount++;
          uniqueCountedForStaff = phoneToSales[phone];
        }
      }
    } else {
      // Reorder (2nd+ kit) — credit Support who re-verified it
      const supportCand = [vId, cId, lId, tId].filter(Boolean);
      for (const cand of supportCand) {
        if (statsMap[cand] && statsMap[cand].user.role === 'support') {
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
      if (phone && phoneToSales[phone] && statsMap[phoneToSales[phone]] && statsMap[phoneToSales[phone]].user.role === 'sales') {
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
    if (statsMap[k]._assignedLeadTaskSet) {
      delete statsMap[k]._assignedLeadTaskSet;
    }
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

  const fetchOrderList = (model, filter) => {
    let q = model.find(filter).select('_id lead_id awb_code order_id status created_by createdAt status_updated_at delivered_at sub_total total');
    if (needsLeadFilter) {
      q = q.populate('lead_id', 'assignedTo department status pending_reorder_source');
    }
    return q.lean();
  };

  const [orderBreakdownSR, deliveredBreakdownSR, blSR, orderBreakdownSM, deliveredBreakdownSM, blSM, opsMonthData, smxInTransitCount, smxOfdCount] = await Promise.all([
    Order.aggregate([
      { $match: allOrderFilter },
      ...leadMatchStage,
      { $lookup: { from: 'leads', localField: 'lead_id', foreignField: '_id', as: 'leadDoc' } },
      { $group: { _id: { $cond: [ { $or: [ { $ifNull: ['$source_order_id', false] }, { $eq: [{ $arrayElemAt: ['$leadDoc.status', 0] }, 'old'] } ] }, 'old', 'new' ] }, count: { $sum: 1 } } }
    ]),
    fetchOrderList(Order, deliveredFilter),
    fetchOrderList(Order, backlogFilter),
    ShipmaxxOrder.aggregate([
      { $match: allOrderFilterSM },
      ...leadMatchStage,
      { $lookup: { from: 'leads', localField: 'lead_id', foreignField: '_id', as: 'leadDoc' } },
      { $group: { _id: { $cond: [ { $or: [ { $ifNull: ['$source_order_id', false] }, { $eq: [{ $arrayElemAt: ['$leadDoc.status', 0] }, 'old'] } ] }, 'old', 'new' ] }, count: { $sum: 1 } } }
    ]),
    fetchOrderList(ShipmaxxOrder, deliveredFilterSM),
    fetchOrderList(ShipmaxxOrder, backlogFilter),
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
    const rawLeadIds = allDeliveredOrders.map(o => o.lead_id ? (o.lead_id._id ? o.lead_id._id : o.lead_id) : null).filter(Boolean);
    const dLeadIds = Array.from(new Set(rawLeadIds.map(String)));
    const [allPastOrders, allPastSmOrders, oldLeads] = await Promise.all([
      dLeadIds.length ? Order.find({ lead_id: { $in: dLeadIds } }).select('_id lead_id createdAt').lean() : [],
      dLeadIds.length ? ShipmaxxOrder.find({ lead_id: { $in: dLeadIds } }).select('_id lead_id createdAt').lean() : [],
      dLeadIds.length ? Lead.find({ _id: { $in: dLeadIds }, $or: [{ status: 'old' }, { pending_reorder_source: { $exists: true, $ne: null } }] }).distinct('_id') : []
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
  if (targetOrders && Array.isArray(targetOrders) && targetOrders.length <= 5000) {
    if (targetOrders.length === 0) return { phoneToSales: {}, leadMap: {} };
    const phones = targetOrders.map(o => (o.billing_phone || '').replace(/\D/g, '').slice(-10)).filter(p => p.length >= 10);
    const uniquePhones = [...new Set(phones)];
    if (uniquePhones.length === 0) {
      allHistory = targetOrders;
    } else {
      const exactPhoneVariants = uniquePhones.flatMap(p => [p, `91${p}`, `+91${p}`, `0${p}`, `+${p}`]);
      const selectFields = '_id lead_id task_created_by created_by verified_by source_order_id billing_phone status createdAt';
      const statusList = ['DELIVERED', 'Delivered', 'delivered', 'DEL', 'del'];
      const [sr, sm] = await Promise.all([
        OrderModel.find({ billing_phone: { $in: exactPhoneVariants }, status: { $in: statusList } }).select(selectFields).lean(),
        ShipmaxxOrderModel.find({ billing_phone: { $in: exactPhoneVariants }, status: { $in: statusList } }).select(selectFields).lean()
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

export const mapStandardStatus = (rawStatus) => {
  if (!rawStatus) return 'pending';
  const s = String(rawStatus).toLowerCase();
  if (['cnp'].includes(s)) return 'cnp';
  if (['call_again', 'follow_up', 'overdue'].includes(s)) return 'call_again';
  if (['verified', 'completed', 'verification', 'ready_to_shipment', 'dispatch', 'dispatched'].includes(s)) return 'verified';
  if (['not_interested', 'cancel_call', 'closed_lost', 'cancelled'].includes(s)) return 'not_interested';
  return 'pending';
};

export const getEmployeePerformanceMatrix = async ({ viewMode = 'daily', month, year, mode = 'assigned', department, from, to }) => {
  const User = (await import('../user/user.model.js')).default;
  const Task = (await import('../task/task.model.js')).default;

  const now = new Date();
  const reqMonth = month !== undefined && month !== null && month !== '' ? Number(month) : now.getMonth();
  const reqYear = year !== undefined && year !== null && year !== '' ? Number(year) : now.getFullYear();

  const IST_OFFSET = 5.5 * 60 * 60 * 1000;

  const staffQuery = { role: { $in: ['sales', 'support'] }, isDeleted: false };
  if (department) staffQuery.department = department;
  const staffList = await User.find(staffQuery).select('_id name role department').sort({ name: 1 }).lean();

  let startDate, endDate;
  if (from && to && viewMode !== 'monthly' && from !== 'all' && to !== 'all') {
    startDate = new Date(`${from}T00:00:00.000+05:30`);
    endDate = new Date(`${to}T23:59:59.999+05:30`);
  } else if (viewMode === 'monthly') {
    startDate = new Date(Date.UTC(reqYear, reqMonth - 5, 1) - IST_OFFSET);
    endDate = new Date(Date.UTC(reqYear, reqMonth + 1, 0, 23, 59, 59, 999) - IST_OFFSET);
  } else {
    startDate = new Date(Date.UTC(reqYear, reqMonth, 1) - IST_OFFSET);
    endDate = new Date(Date.UTC(reqYear, reqMonth + 1, 0, 23, 59, 59, 999) - IST_OFFSET);
  }

  const taskQuery = {
    isDeleted: false,
    assignedTo: { $in: staffList.map(s => s._id) }
  };
  if (department) taskQuery.department = department;

  if (mode === 'activity') {
    taskQuery.status = { $ne: 'pending' };
    taskQuery.updatedAt = { $gte: startDate, $lte: endDate };
  } else {
    taskQuery.createdAt = { $gte: startDate, $lte: endDate };
  }

  const tasks = await Task.find(taskQuery).select('_id assignedTo status createdAt updatedAt last_action_at next_call_at cnp_attempts').lean();

  const columns = [];
  if (viewMode === 'daily') {
    const daysInMonth = new Date(reqYear, reqMonth + 1, 0).getDate();
    for (let d = 1; d <= daysInMonth; d++) {
      const dt = new Date(reqYear, reqMonth, d);
      const dayStr = `${reqYear}-${String(reqMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const weekday = dt.toLocaleDateString('en-US', { weekday: 'short' });
      columns.push({ key: dayStr, label: `${d}`, sublabel: weekday, date: dayStr });
    }
  } else if (viewMode === 'weekly') {
    let current = new Date(startDate.getTime() + IST_OFFSET);
    let weekIndex = 1;
    while (current <= new Date(endDate.getTime() + IST_OFFSET)) {
      const wStart = new Date(current);
      const wEnd = new Date(current);
      wEnd.setDate(wEnd.getDate() + 6);
      const startStr = wStart.toISOString().slice(0, 10);
      const endStr = wEnd.toISOString().slice(0, 10);
      columns.push({
        key: `W${weekIndex}_${startStr}`,
        label: `Week ${weekIndex}`,
        sublabel: `${wStart.getDate()}/${wStart.getMonth()+1} - ${wEnd.getDate()}/${wEnd.getMonth()+1}`,
        startStr,
        endStr
      });
      weekIndex++;
      current.setDate(current.getDate() + 7);
    }
  } else if (viewMode === 'monthly') {
    for (let m = 5; m >= 0; m--) {
      const dt = new Date(reqYear, reqMonth - m, 1);
      const mKey = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
      const mLabel = dt.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
      columns.push({ key: mKey, label: mLabel, sublabel: '' });
    }
  }

  const matrixMap = {};
  staffList.forEach(s => {
    const sId = String(s._id);
    matrixMap[sId] = {
      staff: s,
      cells: {},
      total: 0,
      statusCounts: { pending: 0, cnp: 0, call_again: 0, verified: 0, not_interested: 0 }
    };
    columns.forEach(col => {
      matrixMap[sId].cells[col.key] = {
        count: 0,
        pending: 0, cnp: 0, call_again: 0, verified: 0, not_interested: 0
      };
    });
  });

  tasks.forEach(t => {
    const sId = String(t.assignedTo);
    if (!matrixMap[sId]) return;

    const targetDateObj = mode === 'activity' ? new Date(t.last_action_at || t.updatedAt) : new Date(t.createdAt);
    const istDate = new Date(targetDateObj.getTime() + IST_OFFSET);
    const dateStr = istDate.toISOString().slice(0, 10);
    const stdStatus = mapStandardStatus(t.status);

    let colKey = null;
    if (viewMode === 'daily') {
      colKey = dateStr;
    } else if (viewMode === 'weekly') {
      const matchCol = columns.find(c => dateStr >= c.startStr && dateStr <= c.endStr);
      if (matchCol) colKey = matchCol.key;
    } else if (viewMode === 'monthly') {
      colKey = `${istDate.getFullYear()}-${String(istDate.getMonth() + 1).padStart(2, '0')}`;
    }

    if (colKey && matrixMap[sId].cells[colKey]) {
      matrixMap[sId].cells[colKey].count++;
      matrixMap[sId].cells[colKey][stdStatus]++;
      matrixMap[sId].total++;
      matrixMap[sId].statusCounts[stdStatus]++;
    }
  });

  return { columns, staffMatrix: Object.values(matrixMap) };
};

export const getStaffDetailKPIs = async ({ staffId, month, year, from, to, department }) => {
  const User = (await import('../user/user.model.js')).default;
  const Task = (await import('../task/task.model.js')).default;

  const now = new Date();
  const staff = await User.findById(staffId).select('_id name role department').lean();
  if (!staff) throw new Error('Staff user not found');

  const IST_OFFSET = 5.5 * 60 * 60 * 1000;
  let startDate = from && from !== 'all' ? new Date(`${from}T00:00:00.000+05:30`) : new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1) - IST_OFFSET);
  let endDate = to && to !== 'all' ? new Date(`${to}T23:59:59.999+05:30`) : new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999) - IST_OFFSET);

  const query = { assignedTo: staffId, isDeleted: false };
  if (department) query.department = department;

  const allTasks = await Task.find(query).lean();

  let pending0to1 = 0, pending2to3 = 0, pending3plus = 0;
  let overdueCount = 0, cnpReviewCount = 0;
  const dailyAssignedMap = {}, dailyCompletedMap = {};
  const activeDaysSet = new Set();

  allTasks.forEach(t => {
    const stdStatus = mapStandardStatus(t.status);
    const createdAt = new Date(t.createdAt);
    const createdDateStr = new Date(createdAt.getTime() + IST_OFFSET).toISOString().slice(0, 10);
    
    if (stdStatus === 'pending') {
      const ageDays = (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24);
      if (ageDays <= 1) pending0to1++;
      else if (ageDays <= 3) pending2to3++;
      else pending3plus++;
    }

    if (stdStatus === 'call_again' && t.next_call_at && new Date(t.next_call_at) < now) {
      overdueCount++;
    }

    if ((t.cnp_attempts || 0) >= 3 || (stdStatus === 'cnp' && (t.notes || []).length >= 3)) {
      cnpReviewCount++;
    }

    if (createdAt >= startDate && createdAt <= endDate) {
      dailyAssignedMap[createdDateStr] = (dailyAssignedMap[createdDateStr] || 0) + 1;
    }
    if (t.last_action_at || (stdStatus !== 'pending' && t.updatedAt)) {
      const actionDate = new Date(t.last_action_at || t.updatedAt);
      const actionDateStr = new Date(actionDate.getTime() + IST_OFFSET).toISOString().slice(0, 10);
      if (actionDate >= startDate && actionDate <= endDate) {
        dailyCompletedMap[actionDateStr] = (dailyCompletedMap[actionDateStr] || 0) + 1;
        activeDaysSet.add(actionDateStr);
      }
    }
  });

  const totalDays = Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24))) || 30;
  const daysWorked = activeDaysSet.size;
  const zeroActionDays = Math.max(0, totalDays - daysWorked);

  return {
    staff,
    aging: { pending0to1, pending2to3, pending3plus },
    overdueCount,
    cnpReviewCount,
    dailyTrend: Object.keys(dailyAssignedMap).map(d => ({ date: d, assigned: dailyAssignedMap[d] || 0, completed: dailyCompletedMap[d] || 0 })),
    daysWorked,
    zeroActionDays
  };
};

export const getTaskDrilldown = async ({ staffId, status, bucket, date, from, to, department }) => {
  const Task = (await import('../task/task.model.js')).default;
  const Verification = (await import('../verification/verification.model.js')).default;

  const query = { isDeleted: false };
  if (staffId) query.assignedTo = staffId;
  if (department) query.department = department;

  if (status) {
    const rawStatuses = [];
    if (status === 'pending') rawStatuses.push('pending', 'new', 'old', 'scheduled', 'task');
    else if (status === 'cnp') rawStatuses.push('cnp');
    else if (status === 'call_again') rawStatuses.push('call_again', 'follow_up', 'overdue');
    else if (status === 'verified') rawStatuses.push('verified', 'completed', 'verification', 'ready_to_shipment', 'dispatch', 'dispatched');
    else if (status === 'not_interested') rawStatuses.push('not_interested', 'cancel_call', 'closed_lost', 'cancelled');

    if (rawStatuses.length > 0) query.status = { $in: rawStatuses };
  }

  let dStart, dEnd;
  if (date) {
    dStart = new Date(`${date}T00:00:00.000+05:30`);
    dEnd = new Date(`${date}T23:59:59.999+05:30`);
    query.createdAt = { $gte: dStart, $lte: dEnd };
  } else if (from && to && from !== 'all' && to !== 'all') {
    dStart = new Date(`${from}T00:00:00.000+05:30`);
    dEnd = new Date(`${to}T23:59:59.999+05:30`);
    query.createdAt = { $gte: dStart, $lte: dEnd };
  }

  if (status === 'verified') {
    const verQuery = { isDeleted: { $ne: true } };
    if (staffId) verQuery.assignedTo = staffId;
    if (department) verQuery.department = department;
    if (dStart && dEnd) {
      verQuery.createdAt = { $gte: dStart, $lte: dEnd };
    }

    const [verifications, tasks] = await Promise.all([
      Verification.find(verQuery)
        .populate('lead', 'name phone city status')
        .populate('assignedTo', 'name role')
        .sort({ createdAt: -1 })
        .limit(200)
        .lean(),
      Task.find(query)
        .populate('lead', 'name phone city status')
        .populate('assignedTo', 'name role')
        .sort({ createdAt: -1 })
        .limit(200)
        .lean()
    ]);

    const items = [];
    const seenLeadIds = new Set();

    verifications.forEach(v => {
      const lId = String(v.lead?._id || v.lead || v._id);
      seenLeadIds.add(lId);
      items.push({
        _id: v._id,
        title: v.title || 'Verification Order',
        leadName: v.lead?.name || 'Customer',
        phone: v.lead?.phone || 'N/A',
        status: mapStandardStatus(v.status),
        rawStatus: v.status,
        staffName: v.assignedTo?.name || 'Unassigned',
        assignedDate: v.createdAt,
        lastActionAt: v.updatedAt || v.createdAt,
        nextCallAt: null,
        cnpAttempts: 0
      });
    });

    tasks.forEach(t => {
      const lId = String(t.lead?._id || t.lead || t._id);
      if (!seenLeadIds.has(lId)) {
        seenLeadIds.add(lId);
        items.push({
          _id: t._id,
          title: t.title || 'Follow-up Task',
          leadName: t.lead?.name || 'Unknown Lead',
          phone: t.phone || t.lead?.phone || 'N/A',
          status: mapStandardStatus(t.status),
          rawStatus: t.status,
          staffName: t.assignedTo?.name || 'Unassigned',
          assignedDate: t.createdAt,
          lastActionAt: t.last_action_at || t.updatedAt,
          nextCallAt: t.next_call_at || null,
          cnpAttempts: t.cnp_attempts || 0
        });
      }
    });

    return items;
  }

  const tasks = await Task.find(query)
    .populate('lead', 'name phone city status')
    .populate('assignedTo', 'name role')
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();

  return tasks.map(t => ({
    _id: t._id,
    title: t.title || 'Follow-up Task',
    leadName: t.lead?.name || 'Unknown Lead',
    phone: t.phone || t.lead?.phone || 'N/A',
    status: mapStandardStatus(t.status),
    rawStatus: t.status,
    staffName: t.assignedTo?.name || 'Unassigned',
    assignedDate: t.createdAt,
    lastActionAt: t.last_action_at || t.updatedAt,
    nextCallAt: t.next_call_at || null,
    cnpAttempts: t.cnp_attempts || 0
  }));
};


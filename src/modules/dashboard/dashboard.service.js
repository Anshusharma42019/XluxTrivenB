import Lead from '../lead/lead.model.js';
import Task from '../task/task.model.js';
import { Order } from '../shiprocket/models/order.model.js';
import Verification from '../verification/verification.model.js';
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
    todayClosedLost
  ] = await Promise.all([
    // monthVerifications = verifications created/in-queue this month (for reference)
    Verification.countDocuments({ ...filter, ...monthDateFilter }),
    Task.countDocuments({ ...filter, status: 'pending', isDeleted: false }),
    StaffTarget.findOne({ user: uid, date: dateStr }),
    Cnp.countDocuments({ ...filter, ...updateDateFilter }),
    CallAgain.countDocuments({ ...filter, ...updateDateFilter }),
    Task.countDocuments({ ...filter, status: 'interested', isDeleted: false, ...updateDateFilter }),
    Task.countDocuments({ ...filter, status: 'cancel_call', isDeleted: false, ...updateDateFilter }),
    Lead.countDocuments({ ...filter, ...dateFilter }),
    // verifiedCount = verifications actually COMPLETED (status: verified or rejected) in the selected period
    Verification.countDocuments({ ...filter, status: { $in: ['verified', 'rejected'] }, ...updateDateFilter }),
    Verification.countDocuments({ ...filter, status: 'on_hold', ...updateDateFilter }),
    Lead.countDocuments({ ...filter, status: 'closed_lost', ...updateDateFilter }),
  ]);

  // todayVerifications = verifications assigned/created today (sent to verification)
  const todayVerifications = await Verification.countDocuments({ ...filter, ...dateFilter });

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
    date: dateStr
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

  const [cnpList, callAgainList, interestedList, notInterestedList, onHoldList, verificationList] = await Promise.all([
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

export const getAllStaffStats = async (targetDate, fromDate, toDate) => {
  const IST_OFFSET = 5.5 * 60 * 60 * 1000;
  let startOfDay, endOfDay;
  const target = targetDate ? new Date(targetDate) : new Date();

  const isAllTime = fromDate === 'all' || toDate === 'all';
  if (isAllTime) {
    startOfDay = new Date(Date.UTC(target.getFullYear(), target.getMonth(), target.getDate()) - IST_OFFSET);
    endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000 - 1);
  } else if (fromDate && toDate) {
    startOfDay = new Date(`${fromDate}T00:00:00.000+05:30`);
    endOfDay = new Date(`${toDate}T23:59:59.999+05:30`);
  } else {
    startOfDay = new Date(Date.UTC(target.getFullYear(), target.getMonth(), target.getDate()) - IST_OFFSET);
    endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000 - 1);
  }

  const monthStart = new Date(Date.UTC(target.getFullYear(), target.getMonth(), 1) - IST_OFFSET);
  const monthEnd = new Date(Date.UTC(target.getFullYear(), target.getMonth() + 1, 0, 23, 59, 59, 999) - IST_OFFSET);
  const dateStr = target.toISOString().slice(0, 10);

  const User = (await import('../user/user.model.js')).default;
  const Appointment = (await import('../appointment/appointment.model.js')).default;
  const Attendance = (await import('../attendance/attendance.model.js')).default;
  const allUsers = await User.find({ role: { $in: ['sales', 'manager', 'doctor', 'support'] }, isDeleted: false }).select('_id name phone role').lean();

  const stats = await Promise.all(allUsers.map(async (u) => {
    const uid = new mongoose.Types.ObjectId(u._id);
    const attendances = await Attendance.find({ user: uid, date: { $gte: startOfDay, $lte: endOfDay }, isDeleted: false }).select('checkIn checkOut workingHours').lean();
    const workingHours = attendances.reduce((acc, curr) => {
      let liveHours = 0;
      if (curr.checkIn && !curr.checkOut) {
        liveHours = (Date.now() - new Date(curr.checkIn).getTime()) / (1000 * 60 * 60);
      }
      return acc + (curr.workingHours || 0) + liveHours;
    }, 0);
    const expectedHours = 9 * Math.max(attendances.length, 1);
    const workingPercentage = Math.min(Math.round((workingHours / expectedHours) * 100), 100);

    if (u.role === 'doctor') {
      const docRegex = new RegExp(u.name.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&'), 'i');
      const [totalAppointments, completedAppointments, cancelledAppointments] = await Promise.all([
        Appointment.countDocuments({ doctorName: docRegex, appointmentDate: { $gte: startOfDay, $lte: endOfDay }, isDeleted: false }),
        Appointment.countDocuments({ doctorName: docRegex, appointmentDate: { $gte: startOfDay, $lte: endOfDay }, status: 'completed', isDeleted: false }),
        Appointment.countDocuments({ doctorName: docRegex, appointmentDate: { $gte: startOfDay, $lte: endOfDay }, status: 'cancelled', isDeleted: false })
      ]);
      return {
        user: u,
        todayVerifications: 0,
        monthVerifications: 0,
        pendingTasks: 0,
        todayTarget: 0,
        todayCnp: 0,
        todayCallAgain: 0,
        todayInterested: 0,
        todayNotInterested: 0,
        todayClosedLost: 0,
        leadsAdded: 0,
        verifiedCount: 0,
        onHoldCount: 0,
        readyToShipmentCount: 0,
        deliveredCount: 0,
        rtoCount: 0,
        totalAppointments,
        completedAppointments,
        cancelledAppointments,
        workingHours,
        workingPercentage
      };
    }
    
    // For delivered orders, we need lead IDs assigned to this staff
    const staffLeads = await Lead.find({ assignedTo: uid, isDeleted: { $ne: true } }).distinct('_id');
    // For verification metrics on sales, we only want leads added in the current period
    const staffLeadsPeriod = await Lead.find({ 
      assignedTo: uid, 
      ...(isAllTime ? {} : { createdAt: { $gte: startOfDay, $lte: endOfDay } }),
      isDeleted: { $ne: true } 
    }).distinct('_id');

    const [
      todayVerifications, 
      monthVerifications, 
      pendingTasks, 
      targetDoc,
      todayCnp, 
      todayCallAgain, 
      todayInterested, 
      todayNotInterested,
      todayClosedLost,
      leadsAdded,
      verifiedCount,
      onHoldCount,
      readyToShipmentCount,
      deliveredCount,
      rtoCount,
      monthDispatchedCount,
      monthDeliveredCount,
      monthRtoCount,
      assignedVerifications
    ] = await Promise.all([
      Verification.countDocuments({ assignedTo: uid, ...(isAllTime ? {} : { createdAt: { $gte: startOfDay, $lte: endOfDay } }) }),
      Verification.countDocuments({ assignedTo: uid, ...(isAllTime ? {} : { createdAt: { $gte: monthStart, $lte: monthEnd } }) }),
      Task.countDocuments({ assignedTo: uid, status: 'pending', isDeleted: false }),
      StaffTarget.find({ user: uid, date: { $gte: fromDate || dateStr, $lte: toDate || dateStr } }).lean(),
      Cnp.countDocuments({ assignedTo: uid, ...(isAllTime ? {} : { updatedAt: { $gte: startOfDay, $lte: endOfDay } }) }),
      CallAgain.countDocuments({ assignedTo: uid, ...(isAllTime ? {} : { updatedAt: { $gte: startOfDay, $lte: endOfDay } }) }),
      Task.countDocuments({ assignedTo: uid, status: 'interested', isDeleted: false, ...(isAllTime ? {} : { updatedAt: { $gte: startOfDay, $lte: endOfDay } }) }),
      Task.countDocuments({ assignedTo: uid, status: 'cancel_call', isDeleted: false, ...(isAllTime ? {} : { updatedAt: { $gte: startOfDay, $lte: endOfDay } }) }),
      Lead.countDocuments({ assignedTo: uid, status: 'closed_lost', ...(isAllTime ? {} : { updatedAt: { $gte: startOfDay, $lte: endOfDay } }) }),
      Lead.countDocuments({ assignedTo: uid, ...(isAllTime ? {} : { createdAt: { $gte: startOfDay, $lte: endOfDay } }) }),
      // VR: verifications this person completed today (they are set as assignedTo when they verify)
      Verification.countDocuments({ 
        assignedTo: uid,
        status: { $in: ['verified', 'rejected'] },
        ...(isAllTime ? {} : { updatedAt: { $gte: startOfDay, $lte: endOfDay } })
      }),
      Verification.countDocuments({ 
        assignedTo: uid,
        status: 'on_hold',
        ...(isAllTime ? {} : { updatedAt: { $gte: startOfDay, $lte: endOfDay } })
      }),
      // DR denominator: total shiprocket orders for this person's leads in the period (dispatched)
      Order.countDocuments({ 
        lead_id: { $in: staffLeads },
        status: { $not: /^(new|pending|cancelled)$/i },
        ...(isAllTime ? {} : { createdAt: { $gte: startOfDay, $lte: endOfDay } })
      }),
      // Daily actuals: how many were delivered TODAY
      Order.countDocuments({ 
        lead_id: { $in: staffLeads }, 
        status: { $in: ['DELIVERED', 'Delivered', 'delivered'] },
        ...(isAllTime ? {} : { updatedAt: { $gte: startOfDay, $lte: endOfDay } })
      }),
      // Daily actuals: how many were RTO TODAY
      Order.countDocuments({
        lead_id: { $in: staffLeads },
        status: { $regex: /^rto/i },
        ...(isAllTime ? {} : { updatedAt: { $gte: startOfDay, $lte: endOfDay } })
      }),
      // Monthly cohort for DR/RTO always
      Order.countDocuments({ 
        lead_id: { $in: staffLeads },
        status: { $not: /^(new|pending|cancelled)$/i },
        createdAt: { $gte: monthStart, $lte: monthEnd }
      }),
      Order.countDocuments({ 
        lead_id: { $in: staffLeads }, 
        status: { $in: ['DELIVERED', 'Delivered', 'delivered'] },
        createdAt: { $gte: monthStart, $lte: monthEnd }
      }),
      Order.countDocuments({
        lead_id: { $in: staffLeads },
        status: { $regex: /^rto/i },
        createdAt: { $gte: monthStart, $lte: monthEnd }
      }),
      // For Support: total verifications ever assigned to them (their queue)
      Verification.countDocuments({ assignedTo: uid, isDeleted: { $ne: true } })
    ]);
    // console.log(`[getAllStaffStats] Staff: ${u.name}, Ready: ${readyToShipmentCount}, Delivered: ${deliveredCount}`);
    return {
      user: u,
      todayVerifications,
      monthVerifications,
      pendingTasks,
      todayTarget: Array.isArray(targetDoc) ? targetDoc.reduce((sum, t) => sum + (t.target || 0), 0) : 0,
      todayCnp,
      todayCallAgain,
      todayInterested,
      todayNotInterested,
      todayClosedLost,
      leadsAdded,
      verifiedCount,
      onHoldCount,
      readyToShipmentCount,
      deliveredCount,
      rtoCount,
      monthDispatchedCount,
      monthDeliveredCount,
      monthRtoCount,
      assignedVerifications,
      workingHours,
      workingPercentage
    };
  }));

  return stats;
};

export const getDashboardStats = async (userRole, userId, targetDate, from, to, userDepartments = []) => {
  // For countDocuments - plugin auto-adds isDeleted:false
  const countFilter = {};
  // For aggregate - plugin does NOT apply, must be explicit
  const aggMatch = { isDeleted: false };

  if (userRole === 'sales') {
    countFilter.assignedTo = userId;
    aggMatch.assignedTo = userId;
  }
  
  if (userDepartments && userDepartments.length > 0) {
    countFilter.department = { $in: userDepartments };
    aggMatch.department = { $in: userDepartments };
  }

  const rtsAggMatch = {};
  if (userRole === 'sales') {
    rtsAggMatch.assignedTo = userId;
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
  ] = await Promise.all([
    Lead.countDocuments(countFilter),

    Lead.countDocuments({ ...countFilter, ...dateFilter }),

    Lead.countDocuments(departmentCountFilter('migraine')),

    Lead.countDocuments(departmentCountFilter('piles')),

    // verified: count Verification records marked 'verified' in the period (this IS the conversion)
    Verification.countDocuments({ ...countFilter, status: 'verified', isDeleted: false, ...updateDateFilter }),

    ReadyToShipment.countDocuments({ 
      ...countFilter,
      sentToShiprocket: { $ne: true },
      ...(isAllTime ? {} : { createdAt: { $gte: start, $lte: end } })
    }),
    
    ReadyToShipment.aggregate([
      { $match: { ...rtsAggMatch, sentToShiprocket: { $ne: true }, ...(isAllTime ? {} : { createdAt: { $gte: start, $lte: end } }) } },
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
      { $match: aggMatch },
      { $group: { _id: '$status', count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),

    Lead.aggregate([
      { $match: aggMatch },
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
  ]);

  const newReadyToShipCount = readyToShipBreakdown?.find(b => b._id === 'new')?.count || 0;
  const oldReadyToShipCount = readyToShipBreakdown?.find(b => b._id === 'old')?.count || 0;

  const stageOrder = ['new', 'contacted', 'interested', 'follow_up', 'closed_won', 'closed_lost'];
  const funnelMap = Object.fromEntries(funnelData.map((f) => [f._id, f.count]));
  const salesFunnel = stageOrder.map((stage) => ({ stage, count: funnelMap[stage] || 0 }));

  const sourcePerformance = sourceData.map((s) => ({
    source: s._id || 'other',
    count: s.count,
    percentage: totalLeads ? Math.round((s.count / totalLeads) * 100) : 0,
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

  const activityStats = {
    todayCnp,
    todayCallAgain,
    todayInterested,
    todayNotInterested,
    todayClosedLost: await Lead.countDocuments({ ...countFilter, status: 'closed_lost', ...updateDateFilter }),
  };

  const staffLeads = await Lead.find(countFilter).distinct('_id');

  // New/Old Orders: count ALL orders created in the period (not just delivered)
  const allOrderFilter = isAllTime ? {} : {
    createdAt: { $gte: start, $lte: end }
  };
  if (userRole === 'sales' || (userDepartments && userDepartments.length > 0)) {
    allOrderFilter.lead_id = { $in: staffLeads };
  }

  // Delivered stats: count orders delivered in the period
  const deliveredFilter = {
    status: { $in: ['DELIVERED', 'Delivered', 'delivered'] },
    ...(isAllTime ? {} : {
      $or: [
        { delivered_at: { $gte: start, $lte: end } },
        { delivered_at: null, status_updated_at: { $gte: start, $lte: end } },
        { delivered_at: null, status_updated_at: null, createdAt: { $gte: start, $lte: end } },
      ]
    })
  };
  if (userRole === 'sales' || (userDepartments && userDepartments.length > 0)) {
    deliveredFilter.lead_id = { $in: staffLeads };
  }

  const [orderBreakdown, deliveredBreakdown, deliveredRevenueResult] = await Promise.all([
    Order.aggregate([
      { $match: allOrderFilter },
      {
        $lookup: {
          from: 'leads',
          localField: 'lead_id',
          foreignField: '_id',
          as: 'leadDoc'
        }
      },
      {
        $group: {
          _id: {
            $cond: [
              {
                $or: [
                  { $ifNull: ['$source_order_id', false] },
                  { $eq: [{ $arrayElemAt: ['$leadDoc.status', 0] }, 'old'] }
                ]
              },
              'old',
              'new'
            ]
          },
          count: { $sum: 1 }
        }
      }
    ]),
    Order.aggregate([
      { $match: deliveredFilter },
      {
        $lookup: {
          from: 'leads',
          localField: 'lead_id',
          foreignField: '_id',
          as: 'leadDoc'
        }
      },
      {
        $group: {
          _id: {
            $cond: [
              {
                $or: [
                  { $ifNull: ['$source_order_id', false] },
                  { $eq: [{ $arrayElemAt: ['$leadDoc.status', 0] }, 'old'] }
                ]
              },
              'old',
              'new'
            ]
          },
          count: { $sum: 1 }
        }
      }
    ]),
    Order.aggregate([
      { $match: deliveredFilter },
      { $group: { _id: null, total: { $sum: SUB_TOTAL_AMOUNT } } },
    ]),
  ]);

  const newOrdersCount = orderBreakdown.find(o => o._id === 'new')?.count || 0;
  const oldOrdersCount = orderBreakdown.find(o => o._id === 'old')?.count || 0;

  const newDeliveredCount = deliveredBreakdown.find(o => o._id === 'new')?.count || 0;
  const oldDeliveredCount = deliveredBreakdown.find(o => o._id === 'old')?.count || 0;
  const deliveredCount = newDeliveredCount + oldDeliveredCount;
  const departmentLeads = {
    migraine: migraineLeadCount,
    piles: pilesLeadCount,
    total: migraineLeadCount + pilesLeadCount,
  };

  // Per-department conversion: Verification records marked 'verified' for each department in the period
  const verifDeptFilter = (dept) => {
    if (countFilter.department && countFilter.department['$in'] && !countFilter.department['$in'].includes(dept)) {
      return { ...countFilter, department: '__none__', status: 'verified', isDeleted: false, ...updateDateFilter };
    }
    return { ...countFilter, department: dept, status: 'verified', isDeleted: false, ...updateDateFilter };
  };
  const [migraineConverted, pilesConverted] = await Promise.all([
    Verification.countDocuments(verifDeptFilter('migraine')),
    Verification.countDocuments(verifDeptFilter('piles')),
  ]);
  const migraineConversionRate = migraineLeadCount > 0 ? Math.round((migraineConverted / migraineLeadCount) * 100) : 0;
  const pilesConversionRate = pilesLeadCount > 0 ? Math.round((pilesConverted / pilesLeadCount) * 100) : 0;

  // Overall conversion rate: verified / new leads in selected period
  const conversionRate = newLeadsToday > 0 ? Math.round((convertedLeads / newLeadsToday) * 100) : 0;

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
    deliveredRevenue: deliveredRevenueResult[0]?.total || 0,
  };
};

export const getStaffCommission = async (userId, month, year) => {
  const User = (await import('../user/user.model.js')).default;
  const Attendance = (await import('../attendance/attendance.model.js')).default;
  const CommissionOverride = (await import('../commission/commissionOverride.model.js')).default;

  const user = await User.findById(userId).lean();
  if (!user) return null;

  const IST_OFFSET = 5.5 * 60 * 60 * 1000;
  const monthStart = new Date(Date.UTC(year, month, 1) - IST_OFFSET);
  const monthEnd = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999) - IST_OFFSET);

  const [attendanceRecords, staffLeads, override, reorderComms] = await Promise.all([
    Attendance.find({ user: userId, date: { $gte: monthStart, $lte: monthEnd }, isDeleted: false }).lean(),
    Lead.find({ assignedTo: userId, isDeleted: { $ne: true } }).distinct('_id'),
    CommissionOverride.findOne({ user: userId, month, year }).lean(),
    ReorderCommission.find({ staff_id: userId, month, year }).lean(),
  ]);

  const attendance = { present: 0, absent: 0, half_day: 0, late: 0 };
  attendanceRecords.forEach(r => { if (attendance[r.status] !== undefined) attendance[r.status]++; });

  const workingDays = attendance.present + attendance.late + attendance.half_day;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const basePay = override?.manualBasePay ?? Math.round((user.baseSalary || 0) * (workingDays / daysInMonth));

  const deliveredCount = await Order.countDocuments({
    lead_id: { $in: staffLeads },
    source_order_id: null,
    status: { $in: ['DELIVERED', 'Delivered', 'delivered'] },
    $or: [
      { delivered_at: { $gte: monthStart, $lte: monthEnd } },
      { delivered_at: null, status_updated_at: { $gte: monthStart, $lte: monthEnd } },
      { delivered_at: null, status_updated_at: null, createdAt: { $gte: monthStart, $lte: monthEnd } },
    ],
  });

  const revenueResult = await Order.aggregate([
    {
      $match: {
        lead_id: { $in: staffLeads },
        source_order_id: null,
        status: { $in: ['DELIVERED', 'Delivered', 'delivered'] },
        $or: [
          { delivered_at: { $gte: monthStart, $lte: monthEnd } },
          { delivered_at: null, status_updated_at: { $gte: monthStart, $lte: monthEnd } },
          { delivered_at: null, status_updated_at: null, createdAt: { $gte: monthStart, $lte: monthEnd } },
        ],
      },
    },
    { $group: { _id: null, total: { $sum: SUB_TOTAL_AMOUNT } } },
  ]);

  const totalRevenue = revenueResult[0]?.total || 0;
  const reorderTotal = reorderComms.reduce((acc, c) => acc + (c.commission_amount || 0), 0);
  const revenueCommission = Math.round(totalRevenue * ((user.commissionRate || 5) / 100));
  
  const totalCommission = override?.manualCommission ?? (revenueCommission + reorderTotal);
  const totalPay = basePay + totalCommission;

  return { 
    user, 
    attendance, 
    totalDeliveries: deliveredCount, 
    totalRevenue, 
    revenueCommission,
    reorderCommission: reorderTotal,
    totalCommission, 
    basePay, 
    totalPay 
  };
};

export const getAllStaffCommissions = async (month, year) => {
  const User = (await import('../user/user.model.js')).default;
  const allUsers = await User.find({ role: { $in: ['sales', 'manager', 'staff'] }, isDeleted: false })
    .select('_id name role baseSalary commissionRate').lean();

  const IST_OFFSET = 5.5 * 60 * 60 * 1000;
  const monthStart = new Date(Date.UTC(year, month, 1) - IST_OFFSET);
  const monthEnd = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999) - IST_OFFSET);

  const staff = await Promise.all(allUsers.map(u => getStaffCommission(u._id, month, year)));
  const validStaff = staff.filter(Boolean);

  // Fetch company-wide totals regardless of assignment
  const totalDeliveries = await Order.countDocuments({
    status: { $in: ['DELIVERED', 'Delivered', 'delivered'] },
    $or: [
      { delivered_at: { $gte: monthStart, $lte: monthEnd } },
      { delivered_at: null, status_updated_at: { $gte: monthStart, $lte: monthEnd } },
      { delivered_at: null, status_updated_at: null, createdAt: { $gte: monthStart, $lte: monthEnd } },
    ],
  });

  const totalRevenueResult = await Order.aggregate([
    {
      $match: {
        status: { $in: ['DELIVERED', 'Delivered', 'delivered'] },
        $or: [
          { delivered_at: { $gte: monthStart, $lte: monthEnd } },
          { delivered_at: null, status_updated_at: { $gte: monthStart, $lte: monthEnd } },
          { delivered_at: null, status_updated_at: null, createdAt: { $gte: monthStart, $lte: monthEnd } },
        ],
      },
    },
    { $group: { _id: null, total: { $sum: SUB_TOTAL_AMOUNT } } },
  ]);

  const grandTotalRevenue = totalRevenueResult[0]?.total || 0;
  const staffDeliveriesSum = validStaff.reduce((s, x) => s + (x.totalDeliveries || 0), 0);
  const staffRevenueSum = validStaff.reduce((s, x) => s + (x.totalRevenue || 0), 0);

  return {
    staff: validStaff,
    grandTotalDeliveries: totalDeliveries, // Show company-wide total
    grandTotalRevenue, // Show company-wide total
    grandTotalCommission: validStaff.reduce((s, x) => s + (x.totalCommission || 0), 0),
    grandTotalPay: validStaff.reduce((s, x) => s + (x.totalPay || 0), 0),
    unassignedDeliveries: Math.max(0, totalDeliveries - staffDeliveriesSum),
    unassignedRevenue: Math.max(0, grandTotalRevenue - staffRevenueSum),
  };
};

export const saveCommissionOverride = async ({ userId, month, year, manualCommission, manualBasePay }) => {
  const CommissionOverride = (await import('../commission/commissionOverride.model.js')).default;
  const update = {};
  if (manualCommission !== undefined) update.manualCommission = manualCommission;
  if (manualBasePay !== undefined) update.manualBasePay = manualBasePay;
  return CommissionOverride.findOneAndUpdate(
    { user: userId, month, year },
    { $set: update },
    { upsert: true, new: true }
  ).lean();
};

export const getRevenueChart = async (userRole, userId, period = 'monthly') => {
  const groupBy = period === 'weekly'
    ? { year: { $year: '$createdAt' }, week: { $week: '$createdAt' } }
    : { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } };

  const sortBy = period === 'weekly'
    ? { '_id.year': 1, '_id.week': 1 }
    : { '_id.year': 1, '_id.month': 1 };

  return Order.aggregate([
    { $match: { status: 'DELIVERED', sub_total: { $gt: 0 } } },
    { $group: { _id: groupBy, revenue: { $sum: SUB_TOTAL_AMOUNT }, count: { $sum: 1 } } },
    { $sort: sortBy },
    { $limit: 12 },
  ]);
};


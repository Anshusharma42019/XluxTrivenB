import httpStatus from 'http-status';
import mongoose from 'mongoose';
import Task from './task.model.js';
import Lead from '../lead/lead.model.js';
import ApiError from '../../utils/ApiError.js';
import { createNotification } from '../notification/notification.service.js';
import Cnp from '../cnp/cnp.model.js';
import Verification from '../verification/verification.model.js';
import ReadyToShipment from '../readytoshipment/readytoshipment.model.js';
import User from '../user/user.model.js';
import { sendVerificationConfirmation } from '../interakt/interakt.service.js';

let lastOverdueCheck = 0;

const notifyAdmins = async (data) => {
  const admins = await User.find({ role: { $in: ['admin', 'manager'] }, isDeleted: false }, '_id');
  await Promise.all(admins.map(a => createNotification({ ...data, user: a._id }).catch(() => {})));
};

const hiddenTaskStatuses = ['verification', 'cnp', 'cancel_call', 'cancelled', 'ready_to_shipment', 'interested', 'on_hold', 'closed_lost'];
const hiddenTaskLeadStatuses = ['closed_lost', 'on_hold', 'follow_up'];

const handleVerificationSync = async (task, userId) => {
  const record = {
    task: task._id,
    title: task.title,
    assignedTo: task.assignedTo?._id || task.assignedTo,
    department: task.department,
    changedBy: userId,
    lead: task.lead?._id || task.lead,
    dueDate: task.dueDate,
    description: task.description,
    problem: task.problem,
    age: task.age,
    weight: task.weight,
    height: task.height,
    otherProblems: task.otherProblems,
    problemDuration: task.problemDuration,
    price: task.price,
    cityVillageType: task.cityVillageType,
    cityVillage: task.cityVillage,
    houseNo: task.houseNo,
    postOffice: task.postOffice,
    district: task.district,
    landmark: task.landmark,
    pincode: task.pincode,
    state: task.state,
    reminderAt: task.reminderAt,
    notes: task.notes,
  };
  const existing = await Verification.findOne({ task: task._id }, '_id');
  await Verification.findOneAndUpdate({ task: task._id }, record, { upsert: true, returnDocument: 'after' });
  await Cnp.deleteOne({ task: task._id });
  await ReadyToShipment.deleteOne({ task: task._id });

  if (!existing) {
    try {
      let leadDoc = null;
      if (task.lead && typeof task.lead === 'object' && task.lead._id) {
          leadDoc = await Lead.findById(task.lead._id).lean();
      } else if (task.lead) {
          leadDoc = await Lead.findById(task.lead).lean();
      }

      let leadPhone = null;
      let leadName = null;
      let leadProblem = null;
      let leadAddress = null;

      if (leadDoc) {
        leadPhone = leadDoc.phone;
        leadName = leadDoc.name;
        leadProblem = leadDoc.problem || '';
        const addrParts = [
          leadDoc.houseNo, leadDoc.cityVillage, leadDoc.postOffice,
          leadDoc.district, leadDoc.state, leadDoc.pincode,
        ].filter(Boolean);
        leadAddress = addrParts.length > 0 ? addrParts.join(', ') : (leadDoc.address || '');
      }

      const finalProblem = leadProblem || task.problem || '';
      const finalPrice = task.price || '';
      const finalAddress = leadAddress || [
        task.houseNo, task.cityVillage, task.postOffice,
        task.district, task.state, task.pincode
      ].filter(Boolean).join(', ') || '';

      if (leadPhone) {
        await sendVerificationConfirmation({
          phone: leadPhone,
          customerName: leadName || task.title,
          problem: finalProblem,
          price: finalPrice,
          address: finalAddress,
        });
      }
    } catch (err) {
      console.error('[WhatsApp] Verification confirmation error for task', task._id, ':', err.message);
    }
  }
};

export const createTask = async (data, createdBy, creatorRole, userDepartments = []) => {
  // inherit department from lead if provided
  if (data.lead) {
    const leadObj = await Lead.findById(data.lead).select('department').lean();
    if (leadObj && leadObj.department) {
      data.department = leadObj.department;
    }
  }
  
  if (!data.department && creatorRole === 'sales' && userDepartments.length > 0) {
    data.department = userDepartments[0];
  }

  // Sales staff can only assign tasks to themselves
  if (creatorRole === 'sales') {
    data.assignedTo = createdBy;
  } else if (!data.assignedTo) {
    const { getNextSalesUser } = await import('../lead/lead.service.js');
    data.assignedTo = await getNextSalesUser(data.department);
  }

  const task = await Task.create({ ...data, createdBy });
  if (task.status === 'verification') {
    await handleVerificationSync(task, createdBy);
  }
  
  await createNotification({
    user: task.assignedTo,
    title: 'New Task Assigned',
    message: `Task "${task.title}" is due on ${new Date(task.dueDate).toDateString()}.`,
    type: 'task_due',
    relatedTask: task._id,
    relatedLead: task.lead,
  });
  await notifyAdmins({ title: 'New Task Created', message: `Task "${task.title}" assigned, due ${new Date(task.dueDate).toDateString()}.`, type: 'task_due', relatedTask: task._id });
  return task;
};

export const getTasks = async (filter, userRole, userId, userDepartments = []) => {
  const query = { isDeleted: false };
  if (userRole === 'sales') {
    query.assignedTo = new mongoose.Types.ObjectId(String(userId));
  } else {
    if (filter.assignedTo) query.assignedTo = new mongoose.Types.ObjectId(String(filter.assignedTo));
    if (filter.department) {
      query.department = filter.department;
    } else if (userDepartments && userDepartments.length > 0) {
      query.department = { $in: userDepartments };
    }
  }
  if (filter.status) {
    query.status = filter.status;
  } else {
    query.status = { $nin: hiddenTaskStatuses };
  }
  if (filter.type) query.type = filter.type;
  if (filter.lead) query.lead = new mongoose.Types.ObjectId(String(filter.lead));

  if (filter.date) {
    const start = new Date(filter.date);
    start.setHours(0, 0, 0, 0);
    const end = new Date(filter.date);
    end.setHours(23, 59, 59, 999);
    query.dueDate = { $gte: start, $lte: end };
  }

  // Run overdue update in background at most once per minute
  const now = Date.now();
  if (now - lastOverdueCheck > 60000) {
    lastOverdueCheck = now;
    Task.updateMany(
      { status: 'pending', dueDate: { $lt: new Date() }, isDeleted: false },
      { status: 'overdue' }
    ).catch(err => console.error('[Task] Overdue check error:', err.message));
  }

  const page = parseInt(filter.page) || 1;
  const limit = parseInt(filter.limit) || 20;
  const skip = (page - 1) * limit;

  const pipeline = [ { $match: query } ];


  pipeline.push({ $sort: { createdAt: -1 } });
  
  const dataPipeline = [
    ...pipeline,
    { $skip: skip },
    { $limit: limit },
    { $project: { _id: 1 } }
  ];

  const countPipeline = [
    ...pipeline,
    { $count: 'count' }
  ];

  const [dataResult, countResult] = await Promise.all([
    Task.aggregate(dataPipeline),
    Task.aggregate(countPipeline)
  ]);

  const taskIds = dataResult.map(r => r._id);
  const total = countResult[0] ? countResult[0].count : 0;

  const tasks = await Task.find({ _id: { $in: taskIds } })
    .populate('assignedTo', 'name email')
    .populate('lead', 'name phone status')
    .sort({ createdAt: -1 });

  return { tasks, total, page, limit, totalPages: Math.ceil(total / limit) };
};

export const getTaskById = async (id, userRole, userId, userDepartments = []) => {
  const task = await Task.findOne({ _id: id, isDeleted: false })
    .populate('assignedTo', 'name email')
    .populate('lead', 'name phone');
  if (!task) throw new ApiError(httpStatus.NOT_FOUND, 'Task not found');
  if (userRole === 'sales') {
    if (String(task.assignedTo?._id) !== String(userId)) {
      throw new ApiError(httpStatus.FORBIDDEN, 'Access denied');
    }
    // Removed department mismatch error so they can view tasks explicitly assigned to them
  }
  return task;
};

export const updateTask = async (id, data, userRole, userId, userDepartments = []) => {
  const task = await getTaskById(id, userRole, userId, userDepartments);
  // Sales staff cannot reassign tasks to other users
  if (userRole === 'sales') delete data.assignedTo;
  Object.assign(task, data);
  await task.save();

  // Sync to dedicated collections on status change
  const record = {
    task: task._id,
    title: task.title,
    assignedTo: task.assignedTo?._id || task.assignedTo,
    department: task.department,
    changedBy: userId,
    lead: task.lead?._id || task.lead,
    dueDate: task.dueDate,
    description: task.description,
    problem: task.problem,
    age: task.age,
    weight: task.weight,
    height: task.height,
    otherProblems: task.otherProblems,
    problemDuration: task.problemDuration,
    price: task.price,
    cityVillageType: task.cityVillageType,
    cityVillage: task.cityVillage,
    houseNo: task.houseNo,
    postOffice: task.postOffice,
    district: task.district,
    landmark: task.landmark,
    pincode: task.pincode,
    state: task.state,
    reminderAt: task.reminderAt,
    notes: task.notes,
  };
  if (data.status === 'cnp') {
    await Cnp.findOneAndUpdate({ task: task._id }, { ...record, lastCnpAt: new Date(), $inc: { cnpCount: 1 }, $push: { cnpHistory: { clickedAt: new Date() } } }, { upsert: true, returnDocument: 'after' });
    await Verification.deleteOne({ task: task._id });
    await ReadyToShipment.deleteOne({ task: task._id });
    if (task.lead) {
      const leadId = task.lead._id || task.lead;
      await Lead.findByIdAndUpdate(leadId, { cnp: true }).catch(() => {});
    }
  } else if (data.status === 'verification') {
    await handleVerificationSync(task, userId);
  } else if (data.status === 'ready_to_shipment') {
    await ReadyToShipment.findOneAndUpdate({ task: task._id }, record, { upsert: true, returnDocument: 'after' });
    await Verification.deleteOne({ task: task._id });
    await Cnp.deleteOne({ task: task._id });
  } else {
    await Cnp.deleteOne({ task: task._id });
    await Verification.deleteOne({ task: task._id });
    await ReadyToShipment.deleteOne({ task: task._id });
  }

  return task;
};

export const deleteTask = async (id) => {
  const task = await Task.findOne({ _id: id, isDeleted: false });
  if (!task) throw new ApiError(httpStatus.NOT_FOUND, 'Task not found');
  task.isDeleted = true;
  await task.save();
};

export const getDailyTasks = async (filter, userId, userRole, userDepartments = []) => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);

  const query = {
    isDeleted: false,
    dueDate: { $gte: start, $lte: end },
    status: { $nin: hiddenTaskStatuses },
  };
  
  if (filter.status) query.status = filter.status;
  if (filter.type) query.type = filter.type;
  
  if (userRole === 'sales') {
    query.assignedTo = new mongoose.Types.ObjectId(String(userId));
  } else {
    if (filter.assignedTo) query.assignedTo = new mongoose.Types.ObjectId(String(filter.assignedTo));
    if (filter.department) {
      query.department = filter.department;
    } else if (userDepartments && userDepartments.length > 0) {
      query.department = { $in: userDepartments };
    }
  }

  return Task.find(query)
    .populate('lead', 'name phone status')
    .populate('assignedTo', 'name email')
    .sort({ priority: -1, dueDate: 1 });
};


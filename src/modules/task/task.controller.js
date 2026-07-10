import httpStatus from 'http-status';
import catchAsync from '../../utils/catchAsync.js';
import ApiResponse from '../../utils/ApiResponse.js';
import * as taskService from './task.service.js';

const createTask = catchAsync(async (req, res) => {
  const task = await taskService.createTask(req.body, req.user._id, req.user.role, req.userDepartments);
  res.status(httpStatus.CREATED).json(new ApiResponse(httpStatus.CREATED, task, 'Task created'));
});

const getTasks = catchAsync(async (req, res) => {
  const tasks = await taskService.getTasks(req.query, req.user.role, req.user._id, req.userDepartments);
  res.json(new ApiResponse(httpStatus.OK, tasks, 'Tasks fetched'));
});

const getDailyTasks = catchAsync(async (req, res) => {
  const tasks = await taskService.getDailyTasks(req.query, req.user._id, req.user.role, req.userDepartments);
  res.json(new ApiResponse(httpStatus.OK, tasks, "Today's tasks fetched"));
});

const getTask = catchAsync(async (req, res) => {
  const task = await taskService.getTaskById(req.params.taskId, req.user.role, req.user._id, req.userDepartments);
  res.json(new ApiResponse(httpStatus.OK, task, 'Task fetched'));
});

const updateTask = catchAsync(async (req, res) => {
  const task = await taskService.updateTask(req.params.taskId, req.body, req.user.role, req.user._id, req.userDepartments);
  res.json(new ApiResponse(httpStatus.OK, task, 'Task updated'));
});

const deleteTask = catchAsync(async (req, res) => {
  await taskService.deleteTask(req.params.taskId);
  res.json(new ApiResponse(httpStatus.OK, null, 'Task deleted'));
});

const addNote = catchAsync(async (req, res) => {
  const task = await taskService.getTaskById(req.params.taskId, req.user.role, req.user._id, req.userDepartments);
  task.notes.push({ text: req.body.text });
  await task.save();

  if (task.lead) {
    const leadId = task.lead._id || task.lead;
    const Lead = (await import('../lead/lead.model.js')).default;
    await Lead.findByIdAndUpdate(leadId, {
      $push: { notes: { text: req.body.text, createdBy: req.user._id } }
    });
  }

  res.json(new ApiResponse(httpStatus.OK, task, 'Note added'));
});

const getTaskByLead = catchAsync(async (req, res) => {
  const Task = (await import('./task.model.js')).default;
  const task = await Task.findOne({ lead: req.params.leadId })
    .sort({ createdAt: -1 })
    .lean();
  res.json(new ApiResponse(httpStatus.OK, task, 'Task fetched'));
});

const checkTasks = catchAsync(async (req, res) => {
  const Task = (await import('./task.model.js')).default;
  const Lead = (await import('../lead/lead.model.js')).default;
  
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end = new Date(); end.setHours(23, 59, 59, 999);
  
  const query = {
    isDeleted: false,
    dueDate: { $gte: start, $lte: end },
    status: { $nin: ['verification', 'cnp', 'cancel_call', 'cancelled', 'ready_to_shipment', 'interested', 'on_hold', 'closed_lost'] }
  };
  
  const hiddenLeadIds = await Lead.distinct('_id', { status: { $in: ['closed_lost', 'on_hold', 'follow_up'] }, isDeleted: { $ne: true } });
  if (hiddenLeadIds.length) {
    query.lead = { $nin: hiddenLeadIds };
  }
  
  const tasks = await Task.find(query).populate('lead', 'name status');
  
  let followUpLeads = 0;
  let callTitleTasks = 0;
  
  tasks.forEach(t => {
    if (t.lead && t.lead.status === 'follow_up') {
      followUpLeads++;
    }
    if (t.title && t.title.toLowerCase().includes('call again')) {
      callTitleTasks++;
    }
  });
  
  res.json({ total: tasks.length, followUpLeads, callTitleTasks, hiddenLeadIdsCount: hiddenLeadIds.length });
});

export default { createTask, getTasks, getDailyTasks, getTask, updateTask, deleteTask, addNote, getTaskByLead, checkTasks };

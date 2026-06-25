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
  const tasks = await taskService.getDailyTasks(req.user._id, req.user.role, req.userDepartments);
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
  res.json(new ApiResponse(httpStatus.OK, task, 'Note added'));
});

const getTaskByLead = catchAsync(async (req, res) => {
  const Task = (await import('./task.model.js')).default;
  const task = await Task.findOne({ lead: req.params.leadId })
    .sort({ createdAt: -1 })
    .lean();
  res.json(new ApiResponse(httpStatus.OK, task, 'Task fetched'));
});

export default { createTask, getTasks, getDailyTasks, getTask, updateTask, deleteTask, addNote, getTaskByLead };

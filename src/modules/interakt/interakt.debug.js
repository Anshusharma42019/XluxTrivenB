import catchAsync from '../../utils/catchAsync.js';
import Task from '../task/task.model.js';
import ApiResponse from '../../utils/ApiResponse.js';

export const debugTasks = catchAsync(async (req, res) => {
  const tasks = await Task.find({}).sort({createdAt: -1}).limit(10);
  res.json(new ApiResponse(200, tasks, "Debug Tasks"));
});

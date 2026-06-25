import httpStatus from 'http-status';
import catchAsync from '../../utils/catchAsync.js';
import ApiResponse from '../../utils/ApiResponse.js';
import * as dashboardService from './dashboard.service.js';

const getStats = catchAsync(async (req, res) => {
  const { date, from, to, department } = req.query;
  const userDepts = ['sales', 'support', 'logistics'].includes(req.user.role) ? req.userDepartments : (department ? [department] : []);
  const stats = await dashboardService.getDashboardStats(req.user.role, req.user._id, date, from, to, userDepts);
  res.json(new ApiResponse(httpStatus.OK, stats, 'Dashboard stats fetched'));
});

const getRevenueChart = catchAsync(async (req, res) => {
  const data = await dashboardService.getRevenueChart(req.user.role, req.user._id, req.query.period);
  res.json(new ApiResponse(httpStatus.OK, data, 'Revenue chart data fetched'));
});

const getStaffStats = catchAsync(async (req, res) => {
  const { date, staffId, from, to, department } = req.query;
  const targetId = (req.user.role === 'manager' || req.user.role === 'admin') && staffId ? staffId : req.user._id;
  const userDepts = ['sales', 'support', 'logistics'].includes(req.user.role) ? req.userDepartments : (department ? [department] : []);
  const data = await dashboardService.getStaffStats(targetId, date, from, to, userDepts);
  res.json(new ApiResponse(httpStatus.OK, data, 'Staff stats fetched'));
});

const setStaffTarget = catchAsync(async (req, res) => {
  const { target, userId, date } = req.body;
  if (!target || Number(target) < 1) {
    return res.status(400).json({ status: 400, message: 'Invalid target value' });
  }
  // Admin/Manager can set target for any user on any date
  const targetUserId = (req.user.role === 'admin' || req.user.role === 'manager') && userId ? userId : req.user._id;
  const data = await dashboardService.setStaffTarget(targetUserId, target, date || undefined);
  res.json(new ApiResponse(httpStatus.OK, data, 'Target saved'));
});

const getTargetHistory = catchAsync(async (req, res) => {
  const { userId, month, year, days } = req.query;
  // Admin/Manager can view any user's history; others see their own
  const targetUserId = (req.user.role === 'admin' || req.user.role === 'manager') && userId ? userId : req.user._id;
  const data = await dashboardService.getTargetHistory(targetUserId, month, year, days);
  res.json(new ApiResponse(httpStatus.OK, data, 'Target history fetched'));
});

const getStaffVerifications = catchAsync(async (req, res) => {
  const data = await dashboardService.getStaffVerifications(req.user._id);
  res.json(new ApiResponse(httpStatus.OK, data, 'Staff verifications fetched'));
});

const getStaffTodayLists = catchAsync(async (req, res) => {
  const { date, staffId, from, to, department } = req.query;
  const userDepts = ['sales', 'support', 'logistics'].includes(req.user.role) ? req.userDepartments : (department ? [department] : []);
  const data = await dashboardService.getStaffTodayLists(req.user.role, req.user._id, date, staffId, from, to, userDepts);
  res.json(new ApiResponse(httpStatus.OK, data, 'Staff today lists fetched'));
});

const getStaffMonthlyChart = catchAsync(async (req, res) => {
  const targetId = (req.user.role === 'admin' || req.user.role === 'manager') ? null : req.user._id;
  const data = await dashboardService.getStaffMonthlyChart(targetId);
  res.json(new ApiResponse(httpStatus.OK, data, 'Monthly chart fetched'));
});

const getAllStaffStats = catchAsync(async (req, res) => {
  const { date, from, to } = req.query;
  const data = await dashboardService.getAllStaffStats(date, from, to);
  res.json(new ApiResponse(httpStatus.OK, data, 'All staff stats fetched'));
});

const getStaffCommission = catchAsync(async (req, res) => {
  const { month, year } = req.query;
  const data = await dashboardService.getStaffCommission(req.user._id, Number(month), Number(year));
  res.json(new ApiResponse(httpStatus.OK, data, 'Staff commission fetched'));
});

const getAllStaffCommissions = catchAsync(async (req, res) => {
  const { month, year } = req.query;
  const data = await dashboardService.getAllStaffCommissions(Number(month), Number(year));
  res.json(new ApiResponse(httpStatus.OK, data, 'All staff commissions fetched'));
});

const saveCommissionOverride = catchAsync(async (req, res) => {
  const data = await dashboardService.saveCommissionOverride(req.body);
  res.json(new ApiResponse(httpStatus.OK, data, 'Commission override saved'));
});

export default { getStats, getRevenueChart, getStaffStats, setStaffTarget, getTargetHistory, getStaffVerifications, getStaffTodayLists, getStaffMonthlyChart, getAllStaffStats, getStaffCommission, getAllStaffCommissions, saveCommissionOverride };

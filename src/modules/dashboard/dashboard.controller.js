import httpStatus from 'http-status';
import catchAsync from '../../utils/catchAsync.js';
import ApiResponse from '../../utils/ApiResponse.js';
import * as dashboardService from './dashboard.service.js';
import { getStaffDeliveryStats } from './dashboard.service.js';

const cache = new Map();
const CACHE_TTL = 60000; // 60 seconds memory cache (automatically purged on data changes)

const withCache = async (key, fetchFn, bypass = false) => {
  if (!bypass) {
    const cached = cache.get(key);
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
      return cached.data;
    }
  }
  const data = await fetchFn();
  cache.set(key, { data, timestamp: Date.now() });
  return data;
};

export const debugDeliveries = catchAsync(async (req, res) => {
  const month = new Date().getMonth();
  const year = new Date().getFullYear();
  const data = await dashboardService.getAllStaffCommissions(month, year);
  res.send({ month, year, data });
});

const getStats = catchAsync(async (req, res) => {
  const { date, from, to, department, refresh } = req.query;
  const userDepts = ['sales', 'support', 'logistics'].includes(req.user.role) ? req.userDepartments : (department ? [department] : []);
  
  const cacheKey = `stats_${req.user.role}_${req.user._id}_${date}_${from}_${to}_${userDepts.join(',')}`;
  const stats = await withCache(cacheKey, () => dashboardService.getDashboardStats(req.user.role, req.user._id, date, from, to, userDepts), refresh === 'true' || refresh === true);
  
  res.json(new ApiResponse(httpStatus.OK, stats, 'Dashboard stats fetched'));
});

const getRevenueChart = catchAsync(async (req, res) => {
  const cacheKey = `revChart_${req.user.role}_${req.user._id}_${req.query.period}`;
  const data = await withCache(cacheKey, () => dashboardService.getRevenueChart(req.user.role, req.user._id, req.query.period));
  res.json(new ApiResponse(httpStatus.OK, data, 'Revenue chart data fetched'));
});

const getStaffStats = catchAsync(async (req, res) => {
  const { date, staffId, from, to, department, preset } = req.query;
  const targetId = (req.user.role === 'manager' || req.user.role === 'admin') && staffId ? staffId : req.user._id;
  const userDepts = ['sales', 'support', 'logistics'].includes(req.user.role) ? req.userDepartments : (department ? [department] : []);
  const data = await dashboardService.getStaffStats(targetId, date, from, to, userDepts, preset);
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
  const { date, staffId, from, to, preset, department, refresh } = req.query;
  const userDepts = ['sales', 'support', 'logistics'].includes(req.user.role) ? req.userDepartments : (department ? [department] : []);
  const effectiveStaffId = (req.user.role === 'admin' || req.user.role === 'manager') && staffId ? staffId : req.user._id;
  
  const cacheKey = `todayLists_${req.user.role}_${effectiveStaffId}_${date}_${from}_${to}_${preset}_${userDepts.join(',')}`;
  const data = await withCache(cacheKey, () => dashboardService.getStaffTodayLists(req.user.role, req.user._id, date, effectiveStaffId, from, to, preset, userDepts), refresh === 'true' || refresh === true);
  
  res.json(new ApiResponse(httpStatus.OK, data, 'Staff today lists fetched'));
});

const getStaffMonthlyChart = catchAsync(async (req, res) => {
  const targetId = req.query.staffId || ((req.user.role === 'admin' || req.user.role === 'manager') ? null : req.user._id);
  
  const cacheKey = `monthlyChart_${targetId}`;
  if (req.query.refresh === 'true') {
    const data = await dashboardService.getStaffMonthlyChart(targetId);
    return res.json(new ApiResponse(httpStatus.OK, data, 'Monthly chart fetched'));
  }
  const data = await withCache(cacheKey, () => dashboardService.getStaffMonthlyChart(targetId));
  
  res.json(new ApiResponse(httpStatus.OK, data, 'Monthly chart fetched'));
});

const SWR_STAFF_CACHE = new Map();

const getAllStaffStats = catchAsync(async (req, res) => {
  const { date, from, to, preset, refresh } = req.query;
  const cacheKey = `allStaff_${req.user.role}_${req.user._id}_${date}_${from}_${to}_${preset}`;
  const data = await withCache(cacheKey, () => dashboardService.getAllStaffStats(date, from, to, preset, req.user), refresh === 'true' || refresh === true);
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

const getUnassignedOrders = catchAsync(async (req, res) => {
  const { month, year } = req.query;
  const data = await dashboardService.getUnassignedOrders(Number(month), Number(year));
  res.json(new ApiResponse(httpStatus.OK, data, 'Unassigned orders fetched'));
});

const assignOrder = catchAsync(async (req, res) => {
  const { orderId, staffId, platform } = req.body;
  const data = await dashboardService.assignOrder(orderId, staffId, platform);
  res.json(new ApiResponse(httpStatus.OK, data, 'Order assigned successfully'));
});

const getStaffDeliveryStatsHandler = catchAsync(async (req, res) => {
  const { month, year, userId, from, to, preset } = req.query;
  const targetId = (req.user.role === 'admin' || req.user.role === 'manager') 
    ? (userId && userId !== 'all' ? userId : null) 
    : req.user._id;
  const data = await getStaffDeliveryStats(Number(month), Number(year), targetId, from, to, preset);
  res.json(new ApiResponse(httpStatus.OK, data, 'Staff delivery stats fetched'));
});

const getMyDeliveryStats = catchAsync(async (req, res) => {
  const { month, year, userId } = req.query;
  const targetId = (req.user.role === 'admin' || req.user.role === 'manager')
    ? (userId && userId !== 'all' ? userId : null)
    : req.user._id;
  const data = await getStaffDeliveryStats(Number(month), Number(year), targetId);
  res.json(new ApiResponse(httpStatus.OK, data, 'My delivery stats fetched'));
});

const getEmployeePerformanceMatrix = catchAsync(async (req, res) => {
  const data = await dashboardService.getEmployeePerformanceMatrix(req.query);
  res.json(new ApiResponse(httpStatus.OK, data, 'Performance matrix fetched'));
});

const getStaffDetailKPIs = catchAsync(async (req, res) => {
  const data = await dashboardService.getStaffDetailKPIs(req.query);
  res.json(new ApiResponse(httpStatus.OK, data, 'Staff KPIs fetched'));
});

const getTaskDrilldown = catchAsync(async (req, res) => {
  const data = await dashboardService.getTaskDrilldown(req.query);
  res.json(new ApiResponse(httpStatus.OK, data, 'Task drilldown fetched'));
});

export default { 
  debugDeliveries, getStats, getRevenueChart, getStaffStats, setStaffTarget, 
  getTargetHistory, getStaffVerifications, getStaffTodayLists, getStaffMonthlyChart, 
  getAllStaffStats, getStaffCommission, getAllStaffCommissions, saveCommissionOverride, 
  getUnassignedOrders, assignOrder, getStaffDeliveryStats: getStaffDeliveryStatsHandler, 
  getMyDeliveryStats, getEmployeePerformanceMatrix, getStaffDetailKPIs, getTaskDrilldown 
};

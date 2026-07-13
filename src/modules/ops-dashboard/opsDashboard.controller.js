import catchAsync from '../../utils/catchAsync.js';
import ApiResponse from '../../utils/ApiResponse.js';
import * as svc from './opsDashboard.service.js';

const OVERALL_ROLES = ['admin', 'manager', 'logistics'];

function extractParams(req) {
  const isOverall = OVERALL_ROLES.includes(req.user?.role);
  // Admin/Manager → see ALL data (staffId = null)
  // Everyone else → see only their own orders (created_by OR verified_by = their _id)
  const staffId = isOverall ? null : String(req.user?._id);

  return {
    preset:       req.query.preset    || 'mtd',
    from:         req.query.from,
    to:           req.query.to,
    hub:          req.query.hub,
    courier:      req.query.courier,
    awb:          req.query.awb,
    state:        req.query.state,
    status:       req.query.status,
    platform:     req.query.platform,
    page:         req.query.page  || 1,
    limit:        req.query.limit || 50,
    rtoThreshold: req.query.rtoThreshold || 8,
    ndrThreshold: req.query.ndrThreshold || 15,
    staffId,
    isOverall,
  };
}

export const getKPIs        = catchAsync(async (req, res) => res.json(new ApiResponse(200, await svc.getKPIs(extractParams(req)),        'KPIs fetched')));
export const getTrend       = catchAsync(async (req, res) => res.json(new ApiResponse(200, await svc.getTrend(extractParams(req)),       'Trend fetched')));
export const getFunnel      = catchAsync(async (req, res) => res.json(new ApiResponse(200, await svc.getFunnel(extractParams(req)),      'Funnel fetched')));
export const getRtoReasons  = catchAsync(async (req, res) => res.json(new ApiResponse(200, await svc.getRtoReasons(extractParams(req)),  'RTO reasons fetched')));
export const getAging       = catchAsync(async (req, res) => res.json(new ApiResponse(200, await svc.getAging(extractParams(req)),       'Aging fetched')));
export const getLeaderboard = catchAsync(async (req, res) => res.json(new ApiResponse(200, await svc.getLeaderboard(extractParams(req)), 'Leaderboard fetched')));
export const getShipments   = catchAsync(async (req, res) => res.json(new ApiResponse(200, await svc.getShipments(extractParams(req)),   'Shipments fetched')));
export const getAlerts      = catchAsync(async (req, res) => res.json(new ApiResponse(200, await svc.getAlerts(extractParams(req)),      'Alerts fetched')));

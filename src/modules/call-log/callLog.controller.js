import httpStatus from 'http-status';
import catchAsync from '../../utils/catchAsync.js';
import ApiResponse from '../../utils/ApiResponse.js';
import ApiError from '../../utils/ApiError.js';
import * as callLogService from './callLog.service.js';

export const sync = catchAsync(async (req, res) => {
  const staffId = req.user.id || req.user._id;
  if (!staffId) {
    throw new ApiError(httpStatus.UNAUTHORIZED, 'Staff ID is required to sync call logs');
  }

  let logs = [];
  if (Array.isArray(req.body.logs)) {
    logs = req.body.logs;
  } else if (Array.isArray(req.body)) {
    logs = req.body;
  } else if (req.body && typeof req.body === 'object') {
    // Single log payload
    logs = [req.body];
  }

  const result = await callLogService.syncCallLogs(staffId, logs);
  res.status(httpStatus.OK).json(new ApiResponse(httpStatus.OK, result, 'Call logs synced successfully'));
});

export const getStats = catchAsync(async (req, res) => {
  const { startDate, endDate, department, staffId } = req.query;
  const result = await callLogService.getCallingStats({
    startDate,
    endDate,
    department,
    staffId,
  });
  res.status(httpStatus.OK).json(new ApiResponse(httpStatus.OK, result, 'Calling telemetry stats fetched successfully'));
});

export const getLogs = catchAsync(async (req, res) => {
  const { page, limit, staffId, department, callType, search, isDuplicate, startDate, endDate } = req.query;
  const result = await callLogService.getCallLogs({
    page,
    limit,
    staffId,
    department,
    callType,
    search,
    isDuplicate,
    startDate,
    endDate,
  });
  res.status(httpStatus.OK).json(new ApiResponse(httpStatus.OK, result, 'Call logs fetched successfully'));
});

export const getLeadHistory = catchAsync(async (req, res) => {
  const phone = req.params.phone || req.query.phone;
  if (!phone) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Phone number is required');
  }
  const result = await callLogService.getLeadCallingHistory(phone);
  res.status(httpStatus.OK).json(new ApiResponse(httpStatus.OK, result, 'Lead calling history fetched successfully'));
});

export const getMissedCalls = catchAsync(async (req, res) => {
  const { page, limit } = req.query;
  const result = await callLogService.getPendingMissedCalls({ page, limit });
  res.status(httpStatus.OK).json(new ApiResponse(httpStatus.OK, result, 'Pending missed calls fetched successfully'));
});

export const resolveMissed = catchAsync(async (req, res) => {
  const { id } = req.params;
  const staffId = req.user.id || req.user._id;
  const result = await callLogService.resolveMissedCall(id, staffId);
  res.status(httpStatus.OK).json(new ApiResponse(httpStatus.OK, result, 'Missed call marked as resolved'));
});


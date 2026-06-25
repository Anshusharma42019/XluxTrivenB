import catchAsync from '../../utils/catchAsync.js';
import attendanceService from './attendance.service.js';
import ApiResponse from '../../utils/ApiResponse.js';

/**
 * Staff clocks in.
 */
const checkIn = catchAsync(async (req, res) => {
  const attendance = await attendanceService.checkIn(req.user._id, req.body);
  res.status(201).send(new ApiResponse(201, attendance, 'Checked in successfully'));
});

/**
 * Staff clocks out.
 */
const checkOut = catchAsync(async (req, res) => {
  const attendance = await attendanceService.checkOut(req.user._id, req.body);
  res.send(new ApiResponse(200, attendance, 'Checked out successfully'));
});

/**
 * Get today's attendance status for logged-in user.
 */
const getTodayStatus = catchAsync(async (req, res) => {
  const attendance = await attendanceService.getTodayStatus(req.user._id);
  res.send(new ApiResponse(200, attendance, 'Today status retrieved'));
});

/**
 * Get logged-in user's attendance history.
 */
const getMyAttendance = catchAsync(async (req, res) => {
  const result = await attendanceService.getMyAttendance(req.user._id, req.query);
  res.send(new ApiResponse(200, result, 'Attendance history retrieved'));
});

/**
 * Admin: get all staff attendance.
 */
const getAllAttendance = catchAsync(async (req, res) => {
  const result = await attendanceService.getAllAttendance(req.query);
  res.send(new ApiResponse(200, result, 'All attendance retrieved'));
});

/**
 * Admin: update attendance record.
 */
const updateAttendance = catchAsync(async (req, res) => {
  const attendance = await attendanceService.updateAttendance(req.params.attendanceId, req.body);
  res.send(new ApiResponse(200, attendance, 'Attendance updated'));
});

export default {
  checkIn,
  checkOut,
  getTodayStatus,
  getMyAttendance,
  getAllAttendance,
  updateAttendance,
};

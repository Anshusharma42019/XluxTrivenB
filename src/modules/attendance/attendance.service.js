import Attendance from './attendance.model.js';
import ApiError from '../../utils/ApiError.js';

/**
 * Get the start-of-day Date for "today" in IST (UTC+5:30),
 * stored as a UTC midnight value.
 */
const getTodayDate = () => {
  const now = new Date();
  // IST offset in ms = +5:30 = 19800000
  const IST_OFFSET = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + IST_OFFSET);
  const y = istNow.getUTCFullYear();
  const m = istNow.getUTCMonth();
  const d = istNow.getUTCDate();
  return new Date(Date.UTC(y, m, d));
};

/**
 * Clock in for today.
 * Supports re-check-in after a completed checkout on the same day.
 */
const checkIn = async (userId, body = {}) => {
  const today = getTodayDate();

  // Check if a record already exists for today
  const existing = await Attendance.findOne({ user: userId, date: today, isDeleted: false });

  if (existing) {
    // If already checked in but NOT yet checked out → block
    if (!existing.checkOut) {
      throw new ApiError(400, 'Already checked in today');
    }

    // Checked out already — allow re-check-in: reset checkIn, clear checkOut & duration
    const now = new Date();
    existing.checkIn = now;
    existing.checkOut = null;
    existing.workingHours = 0;
    existing.sessionDuration = '';
    if (body.notes) existing.notes = body.notes;
    await existing.save();
    return existing;
  }

  // Determine status based on IST time
  const now = new Date();
  const IST_OFFSET = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + IST_OFFSET);
  const hours = istNow.getUTCHours();
  const minutes = istNow.getUTCMinutes();
  const totalMinutes = hours * 60 + minutes;

  let status = 'present';
  if (totalMinutes > 12 * 60) { // After 12:00 PM
    status = 'half_day';
  } else if (totalMinutes > 10 * 60 + 30) { // After 10:30 AM
    status = 'late';
  }

  const attendance = await Attendance.create({
    user: userId,
    date: today,
    checkIn: new Date(),
    notes: body.notes || '',
    checkInLocation: body.checkInLocation || '',
    status,
  });

  return attendance;
};

/**
 * Clock out for today.
 */
const checkOut = async (userId, body = {}) => {
  const today = getTodayDate();

  const attendance = await Attendance.findOne({ user: userId, date: today, isDeleted: false });
  if (!attendance) {
    throw new ApiError(400, 'You have not checked in today');
  }
  if (attendance.checkOut) {
    throw new ApiError(400, 'Already checked out today');
  }

  const checkOutTime = new Date();
  attendance.checkOut = checkOutTime;
  
  if (attendance.checkIn) {
    const diffMs = checkOutTime - attendance.checkIn;
    const diffHrs = diffMs / (1000 * 60 * 60);
    attendance.workingHours = Math.round(diffHrs * 100) / 100;
    
    const h = Math.floor(diffHrs);
    const m = Math.floor((diffHrs - h) * 60);
    attendance.sessionDuration = `${h}h ${m}m`;
  }

  if (body.notes) attendance.notes = body.notes;
  await attendance.save();

  return attendance;
};

/**
 * Get today's attendance status for a user.
 */
const getTodayStatus = async (userId) => {
  const today = getTodayDate();
  const attendance = await Attendance.findOne({ user: userId, date: today, isDeleted: false });
  return attendance || null;
};

/**
 * Get attendance history for a specific user (with date range filter).
 */
const getMyAttendance = async (userId, query = {}) => {
  const filter = { user: userId, isDeleted: false };

  if (query.startDate || query.endDate) {
    filter.date = {};
    if (query.startDate) filter.date.$gte = new Date(query.startDate);
    if (query.endDate) filter.date.$lte = new Date(query.endDate);
  }

  const page = parseInt(query.page) || 1;
  const limit = parseInt(query.limit) || 50;
  const skip = (page - 1) * limit;

  const [results, totalResults] = await Promise.all([
    Attendance.find(filter).sort({ date: -1 }).skip(skip).limit(limit),
    Attendance.countDocuments(filter),
  ]);

  return { results, totalResults, page, limit };
};

/**
 * Get all staff attendance (admin/manager).
 */
const getAllAttendance = async (query = {}) => {
  const filter = { isDeleted: false };

  if (query.userId) {
    filter.user = query.userId;
  }
  if (query.startDate || query.endDate) {
    filter.date = {};
    if (query.startDate) filter.date.$gte = new Date(query.startDate);
    if (query.endDate) filter.date.$lte = new Date(query.endDate);
  }

  const page = parseInt(query.page) || 1;
  const limit = parseInt(query.limit) || 100;
  const skip = (page - 1) * limit;

  const [results, totalResults] = await Promise.all([
    Attendance.find(filter)
      .populate('user', 'name phone role avatar')
      .sort({ date: -1 })
      .skip(skip)
      .limit(limit),
    Attendance.countDocuments(filter),
  ]);

  return { results, totalResults, page, limit };
};

/**
 * Admin update attendance record (status, notes).
 */
const updateAttendance = async (attendanceId, body) => {
  const attendance = await Attendance.findOne({ _id: attendanceId, isDeleted: false });
  if (!attendance) {
    throw new ApiError(404, 'Attendance record not found');
  }

  if (body.status !== undefined) attendance.status = body.status;
  if (body.notes !== undefined) attendance.notes = body.notes;
  await attendance.save();

  return attendance;
};

/**
 * Auto check-out all users who have been checked in for more than X hours.
 * Defaults to 10 hours as requested.
 */
const autoCheckOutByDuration = async (maxHours = 10) => {
  const today = getTodayDate();
  const checkedInUsers = await Attendance.find({ 
    date: today, 
    checkOut: null, 
    isDeleted: false 
  });

  const now = new Date();
  const maxMs = maxHours * 60 * 60 * 1000;
  let count = 0;

  for (const attendance of checkedInUsers) {
    if (attendance.checkIn) {
      const diffMs = now - attendance.checkIn;
      
      if (diffMs >= maxMs) {
        const diffHrs = diffMs / (1000 * 60 * 60);
        attendance.checkOut = now;
        attendance.workingHours = Math.round(diffHrs * 100) / 100;
        
        const h = Math.floor(diffHrs);
        const m = Math.floor((diffHrs - h) * 60);
        attendance.sessionDuration = `${h}h ${m}m`;
        
        attendance.notes = attendance.notes ? `${attendance.notes} (Auto Checked-out after ${maxHours}h)` : `Auto Checked-out after ${maxHours}h`;
        await attendance.save();
        count++;
      }
    }
  }
  return count;
};

export default {
  checkIn,
  checkOut,
  autoCheckOutByDuration,
  getTodayStatus,
  getMyAttendance,
  getAllAttendance,
  updateAttendance,
};

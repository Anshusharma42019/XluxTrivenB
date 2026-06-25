import Attendance from '../modules/attendance/attendance.model.js';
import StaffTarget from '../modules/dashboard/staffTarget.model.js';
import ApiError from '../utils/ApiError.js';
import catchAsync from '../utils/catchAsync.js';

const getTodayDate = () => {
  const now = new Date();
  const IST_OFFSET = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + IST_OFFSET);
  return new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate()));
};

const getTodayDateStr = () => {
  const now = new Date();
  const IST_OFFSET = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + IST_OFFSET);
  const year = istNow.getUTCFullYear();
  const month = String(istNow.getUTCMonth() + 1).padStart(2, '0');
  const day = String(istNow.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/**
 Blocks the request if the user has not checked in today or has not set their target.
 Must be used after auth() middleware.
 */
const requireCheckedIn = catchAsync(async (req, res, next) => {
  if (req.user.role === 'admin') return next();
  const today = getTodayDate();
  const attendance = await Attendance.findOne({ user: req.user._id, date: today, isDeleted: false });
  if (!attendance || !attendance.checkIn) {
    throw new ApiError(403, 'You must check in before performing this action');
  }

  // Check target
  if (!['manager', 'logistics', 'logistic', 'admin'].includes(req.user.role)) {
    const todayStr = getTodayDateStr();
    const target = await StaffTarget.findOne({ user: req.user._id, date: todayStr });
    if (!target || target.target < 1) {
      throw new ApiError(403, 'You must set today\'s target before performing this action');
    }
  }

  next();
});

export default requireCheckedIn;


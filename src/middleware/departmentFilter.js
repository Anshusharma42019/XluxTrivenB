import User from '../modules/user/user.model.js';
import catchAsync from '../utils/catchAsync.js';

/**
 * Middleware to fetch and attach the user's departments to the request.
 * Requires auth middleware to run before it.
 */
const departmentFilter = catchAsync(async (req, res, next) => {
  if (!req.user || !req.user._id) {
    req.userDepartments = [];
    return next();
  }

  const user = await User.findById(req.user._id).select('departments').lean();
  req.userDepartments = user?.departments || [];
  
  next();
});

export default departmentFilter;

/**
 * Middleware to attach user's departments from JWT token (no DB call needed).
 */
const departmentFilter = (req, res, next) => {
  req.userDepartments = req.user?.departments || [];
  next();
};

export default departmentFilter;

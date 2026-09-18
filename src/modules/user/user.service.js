import { User } from './user.model.js';
import ApiError from '../../utils/ApiError.js';
import QueryHelper from '../../utils/queryHelper.js';
import Task from '../task/task.model.js';

/**
 * Handle user creation.
 */
const createUser = async (userBody) => {
  if (userBody.phone && await User.isPhoneTaken(userBody.phone)) {
    throw new ApiError(400, 'Phone number already taken');
  }
  if (!userBody.email) delete userBody.email;
  if (userBody.departments && userBody.departments.length > 0 && !userBody.departmentAccessGrantedAt) {
    userBody.departmentAccessGrantedAt = new Date();
  }
  return User.create(userBody);
};

/**
 * Handle user data retrieval.
 */
const queryUsers = async (filter, options) => {
  const queryHelper = new QueryHelper(User, { ...filter, ...options });
  return queryHelper.execute();
};

/**
 * Get user by ID.
 */
const getUserById = async (id) => {
  return User.findById(id);
};

/**
 * Update user data by ID.
 */
const updateUserById = async (userId, updateBody) => {
  const user = await getUserById(userId);
  if (!user) {
    throw new ApiError(404, 'User not found');
  }
  if (updateBody.phone && (await User.isPhoneTaken(updateBody.phone, userId))) {
    throw new ApiError(400, 'Phone number already taken');
  }
  if (!updateBody.email) delete updateBody.email;
  if (updateBody.departments !== undefined) {
    const prevDepts = (user.departments || []).slice().sort().join(',');
    const newDepts = (updateBody.departments || []).slice().sort().join(',');
    if (newDepts && newDepts !== prevDepts) {
      updateBody.departmentAccessGrantedAt = new Date();
    } else if (!newDepts) {
      updateBody.departmentAccessGrantedAt = null;
    }
  }
  Object.assign(user, updateBody);
  await user.save();
  return user;
};

/**
 * Soft delete user by ID.
 */
const deleteUserById = async (userId) => {
  const user = await getUserById(userId);
  if (!user) {
    throw new ApiError(404, 'User not found');
  }
  await user.softDelete();

  // If deleted user had assigned follow-ups, immediately reassign them to available active support staff
  try {
    const { distributeUnassignedFollowupsEqually, invalidateFollowupCache } = await import('../shipmaxx/shipmaxx.controller.js');
    await distributeUnassignedFollowupsEqually();
    invalidateFollowupCache();
  } catch (err) {
    console.error('[deleteUserById] Error auto-redistributing followups:', err.message);
  }

  return user;
};

const getStaffShipmentCounts = async () => {
  const counts = await Task.aggregate([
    { $match: { status: { $in: ['ready_to_shipment', 'dispatch', 'dispatched'] }, isDeleted: false } },
    { $group: { _id: '$assignedTo', count: { $sum: 1 } } },
  ]);
  return counts.reduce((acc, { _id, count }) => { acc[String(_id)] = count; return acc; }, {});
};

/**
 * Update user avatar by ID.
 */
const updateAvatar = async (userId, avatar) => {
  const user = await getUserById(userId);
  if (!user) throw new ApiError(404, 'User not found');
  user.avatar = avatar;
  await user.save();
  return user;
};

export default {
  createUser,
  queryUsers,
  getUserById,
  updateUserById,
  deleteUserById,
  getStaffShipmentCounts,
  updateAvatar,
};

import express from 'express';
import auth from '../../middleware/auth.js';
import validate from '../../middleware/validate.js';
import upload from '../../middleware/upload.js';
import * as userValidation from './user.validation.js';
import userController from './user.controller.js';
import catchAsync from '../../utils/catchAsync.js';
import ApiResponse from '../../utils/ApiResponse.js';

const router = express.Router();

router
  .route('/')
  .post(auth('admin', 'manager'), validate(userValidation.createUser), userController.createUser)
  .get(auth('admin', 'manager', 'staff', 'sales', 'doctor', 'support'), validate(userValidation.getUsers), userController.getUsers);
  
router.get('/me', auth(), catchAsync(async (req, res) => {
  const User = (await import('./user.model.js')).default;
  const user = await User.findById(req.user.id);
  res.send(new ApiResponse(200, user, 'User profile fetched'));
}));

router.patch('/me', auth(), catchAsync(async (req, res) => {
  const userService = (await import('./user.service.js')).default;
  const user = await userService.updateUserById(req.user.id, req.body);
  res.send(new ApiResponse(200, user, 'Profile updated successfully'));
}));

router.get('/test-users', async (req, res) => {
  try {
    const User = (await import('./user.model.js')).default;
    const users = await User.find({}).lean();
    res.json(users.map(u => ({ id: u._id, name: u.name, role: u.role, depts: u.departments })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


router.get('/stats/shipment-counts', auth('admin', 'manager'), userController.getStaffShipmentCounts);

// Any logged-in user can update their own avatar
router.patch('/me/avatar', auth('admin', 'manager', 'sales', 'support', 'logistics'), upload.single('avatar'), userController.uploadAvatar);

router
  .route('/:userId')
  .get(auth('admin', 'manager', 'sales', 'support', 'logistics'), validate(userValidation.getUser), userController.getUser)
  .patch(auth('admin', 'manager'), validate(userValidation.updateUser), userController.updateUser)
  .delete(auth('admin', 'manager'), validate(userValidation.deleteUser), userController.deleteUser);

export default router;

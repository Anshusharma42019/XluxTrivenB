import express from 'express';
import auth from '../../middleware/auth.js';
import notificationController from './notification.controller.js';

const router = express.Router();

router.get('/', auth('admin', 'manager', 'sales', 'support', 'logistics'), notificationController.getNotifications);
router.patch('/read-all', auth('admin', 'manager', 'sales', 'support', 'logistics'), notificationController.markAllAsRead);
router.patch('/:notificationId/read', auth('admin', 'manager', 'sales', 'support', 'logistics'), notificationController.markAsRead);
router.delete('/', auth('admin', 'manager', 'sales', 'support', 'logistics'), notificationController.deleteAllNotifications);
router.delete('/:notificationId', auth('admin', 'manager', 'sales', 'support', 'logistics'), notificationController.deleteNotification);

export default router;

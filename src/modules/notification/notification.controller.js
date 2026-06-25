import httpStatus from 'http-status';
import catchAsync from '../../utils/catchAsync.js';
import ApiResponse from '../../utils/ApiResponse.js';
import * as notificationService from './notification.service.js';

const getNotifications = catchAsync(async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const result = await notificationService.getUserNotifications(req.user._id, page, limit);
  res.json(new ApiResponse(httpStatus.OK, result, 'Notifications fetched'));
});

const markAsRead = catchAsync(async (req, res) => {
  const notification = await notificationService.markAsRead(req.params.notificationId, req.user._id);
  res.json(new ApiResponse(httpStatus.OK, notification, 'Marked as read'));
});

const markAllAsRead = catchAsync(async (req, res) => {
  await notificationService.markAllAsRead(req.user._id);
  res.json(new ApiResponse(httpStatus.OK, null, 'All notifications marked as read'));
});

const deleteNotification = catchAsync(async (req, res) => {
  await notificationService.deleteNotification(req.params.notificationId, req.user._id);
  res.json(new ApiResponse(httpStatus.OK, null, 'Notification deleted'));
});

const deleteAllNotifications = catchAsync(async (req, res) => {
  await notificationService.deleteAllNotifications(req.user._id);
  res.json(new ApiResponse(httpStatus.OK, null, 'All notifications deleted'));
});

export default { getNotifications, markAsRead, markAllAsRead, deleteNotification, deleteAllNotifications };

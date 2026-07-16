import Notification from './notification.model.js';

export const createNotification = async (data) => {
  return Notification.create(data);
};

export const getUserNotifications = async (userId, page = 1, limit = 20, isWa = false) => {
  const skip = (page - 1) * limit;
  const filter = { user: userId };
  if (isWa) {
    filter.title = { $in: ['New Bulk WhatsApp Reply', 'New WhatsApp Reply', 'New WhatsApp Lead'] };
  }
  const [notifications, total, unreadCount] = await Promise.all([
    Notification.find(filter)
      .populate('relatedLead', 'name phone')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Notification.countDocuments(filter),
    Notification.countDocuments({ ...filter, isRead: false }),
  ]);
  return { notifications, total, unreadCount, page, limit };
};

export const markAsRead = async (notificationId, userId) => {
  return Notification.findOneAndUpdate(
    { _id: notificationId, user: userId },
    { isRead: true },
    { returnDocument: 'after' }
  );
};

export const markAllAsRead = async (userId) => {
  return Notification.updateMany({ user: userId, isRead: false }, { isRead: true });
};

export const deleteNotification = async (notificationId, userId) => {
  return Notification.findOneAndDelete({ _id: notificationId, user: userId });
};

export const deleteAllNotifications = async (userId) => {
  return Notification.deleteMany({ user: userId });
};

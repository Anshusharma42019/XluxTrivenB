import mongoose from 'mongoose';

const notificationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, required: true },
    message: { type: String, required: true },
    type: {
      type: String,
      enum: ['lead_assigned', 'task_due', 'task_overdue', 'lead_status_changed', 'reminder', 'general'],
      default: 'general',
    },
    relatedLead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' },
    relatedTask: { type: mongoose.Schema.Types.ObjectId, ref: 'Task' },
    isRead: { type: Boolean, default: false },
  },
  { timestamps: true }
);

notificationSchema.index({ user: 1, isRead: 1, createdAt: -1 });

notificationSchema.set('toJSON', {
  transform: (doc, ret) => { delete ret.__v; return ret; },
});

export const Notification = mongoose.model('Notification', notificationSchema);
export default Notification;

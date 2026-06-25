import mongoose from 'mongoose';
import softDeletePlugin from '../../utils/softDelete.js';

const attendanceSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    date: {
      type: Date,
      required: true,
    },
    checkIn: {
      type: Date,
      default: null,
    },
    checkOut: {
      type: Date,
      default: null,
    },
    status: {
      type: String,
      enum: ['present', 'absent', 'half_day', 'late'],
      default: 'present',
    },
    notes: {
      type: String,
      trim: true,
      default: '',
    },
    checkInLocation: {
      type: String,
      trim: true,
      default: '',
    },
    workingHours: {
      type: Number,
      default: 0,
    },
    sessionDuration: {
      type: String,
      default: '',
    },
  },
  {
    timestamps: true,
  }
);

// Prevent duplicate attendance per user per day
attendanceSchema.index({ user: 1, date: 1 }, { unique: true });

// Add soft delete plugin
attendanceSchema.plugin(softDeletePlugin);

// Remove __v from JSON
attendanceSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

export const Attendance = mongoose.model('Attendance', attendanceSchema);
export default Attendance;

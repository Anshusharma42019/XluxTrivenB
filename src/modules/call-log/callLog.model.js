import mongoose from 'mongoose';

const callLogSchema = new mongoose.Schema(
  {
    staffId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    phoneNumber: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    rawPhoneNumber: {
      type: String,
      trim: true,
    },
    leadId: {
      type: mongoose.Schema.Types.ObjectId,
      refPath: 'leadModel',
      default: null,
      index: true,
    },
    leadModel: {
      type: String,
      enum: ['Lead', 'Cnp', 'CallAgain', 'Verification', 'InterestedLead', 'VerifiedOrder', 'ShiprocketOrder', 'ShipmaxxOrder', null],
      default: null,
    },
    leadName: {
      type: String,
      trim: true,
      default: null,
    },
    callType: {
      type: String,
      enum: ['outgoing', 'incoming', 'missed', 'rejected'],
      required: true,
      index: true,
    },
    duration: {
      type: Number, // in seconds (0 for unanswered/missed/rejected)
      default: 0,
      min: 0,
    },
    timestamp: {
      type: Date,
      required: true,
      index: true,
    },
    simSlot: {
      type: Number, // 0 for SIM 1, 1 for SIM 2
      default: 0,
    },
    department: {
      type: String,
      enum: ['migraine', 'piles', null],
      default: null,
      index: true,
    },
    isDuplicate: {
      type: Boolean,
      default: false,
      index: true,
    },
    duplicateWithStaff: [
      {
        staffId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        timestamp: { type: Date },
      },
    ],
    status: {
      type: String,
      enum: ['processed', 'unmatched', 'missed_pending', 'missed_resolved'],
      default: 'processed',
      index: true,
    },
    resolvedAt: {
      type: Date,
      default: null,
    },
    resolvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    notes: {
      type: String,
      trim: true,
      default: '',
    },
    source: {
      type: String,
      default: 'android_apk',
    },
  },
  {
    timestamps: true,
  }
);

// Compound indexes for fast telemetry queries
callLogSchema.index({ staffId: 1, timestamp: -1 });
callLogSchema.index({ phoneNumber: 1, timestamp: -1 });
callLogSchema.index({ callType: 1, status: 1, timestamp: -1 });
callLogSchema.index({ department: 1, timestamp: -1 });
// Unique composite check to prevent duplicate syncs of the same phone call event
callLogSchema.index({ staffId: 1, phoneNumber: 1, timestamp: 1, duration: 1 }, { unique: true, sparse: true });

export const CallLog = mongoose.model('CallLog', callLogSchema);
export default CallLog;


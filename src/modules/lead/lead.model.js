import mongoose from 'mongoose';

const leadSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true },
    address: { type: String, trim: true },
    houseNo: { type: String, trim: true },
    cityVillage: { type: String, trim: true },
    cityVillageType: { type: String, enum: ['city', 'village'], default: 'city' },
    postOffice: { type: String, trim: true },
    landmark: { type: String, trim: true },
    district: { type: String, trim: true },
    state: { type: String, trim: true },
    pincode: { type: String, trim: true },
    source: {
      type: String,
      enum: ['website', 'referral', 'social_media', 'cold_call', 'email', 'walk_in', 'other'],
      default: 'other',
    },
    status: {
      type: String,
      enum: ['new', 'contacted', 'interested', 'follow_up', 'closed_won', 'closed_lost', 'on_hold', 'old'],
      default: 'new',
    },
    note: { type: String },
    notes: [{ text: { type: String }, createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, createdAt: { type: Date, default: Date.now }, direction: { type: String, enum: ['inbound', 'outbound'], default: 'inbound' } }],
    problem: { type: String },
    type: {
      type: String,
      enum: ['general', 'ayurveda', 'panchakarma', 'consultation', 'product', 'other'],
      default: 'general',
    },
    revenue: { type: Number, default: 0 },
    cnp: { type: Boolean, default: false },
    cnpCount: { type: Number, default: 0 },
    cnpAt: { type: Date },
    follow_ups: [{
      date: { type: Date, default: Date.now },
      note: String,
      next_date: Date,
      createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    }],
    next_follow_up: Date,
    onHoldReason: { type: String },
    onHoldUntil: { type: Date },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date },
    // Tracks if this lead was sent to re-verification from follow-up cycle
    pending_reorder_source: { type: mongoose.Schema.Types.ObjectId, ref: 'ShiprocketOrder', default: null },
    pending_reorder_staff: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    department: {
      type: String,
      enum: ['migraine', 'piles'],
      default: null,
    },
  },
  { timestamps: true }
);

leadSchema.index({ status: 1, assignedTo: 1, createdAt: -1 });
leadSchema.index({ name: 'text', phone: 'text', email: 'text' });
leadSchema.index({ department: 1, status: 1 });
leadSchema.index({ assignedTo: 1, createdAt: -1 });
leadSchema.index({ assignedTo: 1, updatedAt: -1 });
leadSchema.index({ department: 1, createdAt: -1 });
leadSchema.index({ department: 1, updatedAt: -1 });
leadSchema.index({ assignedTo: 1, department: 1, status: 1, isDeleted: 1, createdAt: -1 });
leadSchema.index({ assignedTo: 1, department: 1, status: 1, isDeleted: 1, updatedAt: -1 });
leadSchema.index({ isDeleted: 1, createdAt: -1 });
leadSchema.index({ isDeleted: 1, updatedAt: -1 });
leadSchema.index({ isDeleted: 1, status: 1, createdAt: -1 });
leadSchema.index({ isDeleted: 1, status: 1, department: 1, createdAt: -1 });
leadSchema.index({ phone: 1, isDeleted: 1 });

leadSchema.set('toJSON', {
  transform: (doc, ret) => { delete ret.__v; return ret; },
});

export const Lead = mongoose.model('Lead', leadSchema);
export default Lead;

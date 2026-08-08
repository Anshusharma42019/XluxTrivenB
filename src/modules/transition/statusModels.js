import mongoose from 'mongoose';

// Standardized Zero-Data-Loss Tracking & Audit Envelope
const standardAuditFields = {
  isArchived: { type: Boolean, default: false },
  isDeleted: { type: Boolean, default: false },
  transferredTo: { type: String, default: null },
  transferredFrom: { type: String, default: null },
  transferredAt: { type: Date, default: null },
  originalCollection: { type: String, default: null },
};

// Comprehensive customer & vitals envelope to ensure zero field stripping during migration
const customerBaseFields = {
  name: { type: String, trim: true },
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
  source: { type: String, default: 'other' },
  status: { type: String, required: true },
  title: { type: String },
  description: { type: String },
  note: { type: String },
  notes: [{
    text: { type: String },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdAt: { type: Date, default: Date.now },
    direction: { type: String, enum: ['inbound', 'outbound'], default: 'inbound' }
  }],
  problem: { type: String },
  type: { type: String, default: 'general' },
  revenue: { type: Number, default: 0 },
  price: { type: Number, default: 0 },
  age: { type: Number },
  weight: { type: Number },
  height: { type: Number },
  otherProblems: { type: String },
  problemDuration: { type: String },
  relief_percentage: { type: Number, default: null },
  department: {
    type: String,
    enum: ['migraine', 'piles', null],
    default: null,
  },
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  dueDate: { type: Date, default: null },
  reminderAt: { type: Date },
  next_follow_up: { type: Date },
  lastWhatsAppMessagedAt: { type: Date },
  doNotContact: { type: Boolean, default: false },
};

const setupStandardIndexes = (schema) => {
  schema.index({ phone: 1, isArchived: 1 });
  schema.index({ isArchived: 1, assignedTo: 1, createdAt: -1 });
  schema.index({ isArchived: 1, department: 1, createdAt: -1 });
  schema.index({ status: 1, isArchived: 1, createdAt: -1 });
  schema.set('toJSON', {
    transform: (doc, ret) => { delete ret.__v; return ret; },
  });
};

// 1. Interested Lead Schema (interestedleads collection)
const interestedLeadSchema = new mongoose.Schema(
  {
    ...customerBaseFields,
    ...standardAuditFields,
  },
  { timestamps: true, strict: false, collection: 'interestedleads' }
);
setupStandardIndexes(interestedLeadSchema);
export const InterestedLead = mongoose.model('InterestedLead', interestedLeadSchema);

// 2. Not Interested Lead Schema (notinterestedleads collection)
const notInterestedLeadSchema = new mongoose.Schema(
  {
    ...customerBaseFields,
    ...standardAuditFields,
    doNotContact: { type: Boolean, default: true },
    rejectionReason: { type: String },
  },
  { timestamps: true, strict: false, collection: 'notinterestedleads' }
);
setupStandardIndexes(notInterestedLeadSchema);
export const NotInterestedLead = mongoose.model('NotInterestedLead', notInterestedLeadSchema);

// 3. Pending Order Schema (pendingorders collection)
const pendingOrderSchema = new mongoose.Schema(
  {
    ...customerBaseFields,
    ...standardAuditFields,
    pendingReason: { type: String },
    priority: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
  },
  { timestamps: true, strict: false, collection: 'pendingorders' }
);
setupStandardIndexes(pendingOrderSchema);
export const PendingOrder = mongoose.model('PendingOrder', pendingOrderSchema);

// 4. On Hold Order Schema (onholdorders collection)
const onHoldOrderSchema = new mongoose.Schema(
  {
    ...customerBaseFields,
    ...standardAuditFields,
    onHoldReason: { type: String },
    onHoldUntil: { type: Date },
    onHoldAt: { type: Date, default: Date.now },
  },
  { timestamps: true, strict: false, collection: 'onholdorders' }
);
setupStandardIndexes(onHoldOrderSchema);
export const OnHoldOrder = mongoose.model('OnHoldOrder', onHoldOrderSchema);

// 5. Verified Order Schema (verifiedorders collection)
const verifiedOrderSchema = new mongoose.Schema(
  {
    ...customerBaseFields,
    ...standardAuditFields,
  },
  { timestamps: true, strict: false, collection: 'verifiedorders' }
);
setupStandardIndexes(verifiedOrderSchema);
export const VerifiedOrder = mongoose.model('VerifiedOrder', verifiedOrderSchema);

export default {
  InterestedLead,
  NotInterestedLead,
  PendingOrder,
  OnHoldOrder,
  VerifiedOrder,
};

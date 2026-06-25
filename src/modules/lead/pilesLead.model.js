import mongoose from 'mongoose';

const pilesLeadSchema = new mongoose.Schema(
  {
    lead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', required: true, unique: true, index: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true, index: true },
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
    next_follow_up: Date,
    onHoldReason: { type: String },
    onHoldUntil: { type: Date },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date },
  },
  { timestamps: true }
);

pilesLeadSchema.index({ status: 1, assignedTo: 1, createdAt: -1 });
pilesLeadSchema.index({ name: 'text', phone: 'text', email: 'text' });

pilesLeadSchema.set('toJSON', {
  transform: (doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

export const PilesLead = mongoose.model('PilesLead', pilesLeadSchema);
export default PilesLead;

import mongoose from 'mongoose';

const followupSchema = new mongoose.Schema({
  order_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ShiprocketOrder', required: true, index: true },
  followup_number: { type: Number, required: true },
  staff: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  status: { type: String, enum: ['scheduled', 'completed', 'missed'], default: 'scheduled', index: true },
  scheduled_date: { type: Date, required: true },
  followup_date: { type: Date },
  next_followup_date: { type: Date },
  completed: { type: Boolean, default: false },
  completed_at: { type: Date },
  notes: { type: String, default: '' },
  note: { type: String, default: '' },
  relief_percentage: { type: Number, default: null },
}, { timestamps: true });

followupSchema.index({ order_id: 1, followup_number: 1 }, { unique: true });

export const Followup = mongoose.model('Followup', followupSchema);
export default Followup;

import mongoose from 'mongoose';

const shipmaxxFollowupSchema = new mongoose.Schema({
  order_id: { type: String, required: true, index: true },
  followup_number: { type: Number, required: true },
  staff: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  status: { type: String, default: 'scheduled', index: true },
  scheduled_date: { type: Date, required: true },
  followup_date: { type: Date },
  next_followup_date: { type: Date },
  completed: { type: Boolean, default: false },
  completed_at: Date,
  notes: { type: String, default: '' },
  note: String,
  relief_percentage: { type: Number, default: null },
  type: { type: String, enum: ['automatic', 'manual'], default: 'automatic' }
}, { timestamps: true });

export const ShipmaxxFollowup = mongoose.model('ShipmaxxFollowup', shipmaxxFollowupSchema);

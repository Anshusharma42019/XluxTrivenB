import mongoose from 'mongoose';

const shipmaxxFollowupSchema = new mongoose.Schema({
  order_id: { type: String, required: true, index: true },
  follow_up_number: { type: Number, required: true },
  scheduled_for: { type: Date, required: true },
  completed: { type: Boolean, default: false },
  completed_at: Date,
  note: String,
  type: { type: String, enum: ['automatic', 'manual'], default: 'automatic' }
}, { timestamps: true });

export const ShipmaxxFollowup = mongoose.model('ShipmaxxFollowup', shipmaxxFollowupSchema);

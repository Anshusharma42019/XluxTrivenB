import mongoose from 'mongoose';

const shipmaxxNdrNoteSchema = new mongoose.Schema({
  order_id: { type: String, required: true, index: true },
  note: { type: String, required: true },
  type: { type: String, enum: ['system', 'user'], default: 'user' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

export const ShipmaxxNdrNote = mongoose.model('ShipmaxxNdrNote', shipmaxxNdrNoteSchema);

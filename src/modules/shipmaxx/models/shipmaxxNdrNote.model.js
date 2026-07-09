import mongoose from 'mongoose';

const shipmaxxNdrNoteSchema = new mongoose.Schema({
  name: { type: String, required: true },
  phone_number: { type: String, required: true },
  reason: { type: String, required: true },
  awb_number: { type: String, required: true, index: true },
  source: { type: String, default: 'shipmaxx' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

export const ShipmaxxNdrNote = mongoose.model('ShipmaxxNdrNote', shipmaxxNdrNoteSchema);

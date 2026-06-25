import mongoose from 'mongoose';

const ndrNoteSchema = new mongoose.Schema({
  name: { type: String, required: true },
  phone_number: { type: String, required: true },
  reason: { type: String, required: true },
  awb_number: { type: String, required: true },
  source: { type: String, enum: ['shiprocket', 'shipmaxx'], default: 'shiprocket' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

export const NdrNote = mongoose.model('NdrNote', ndrNoteSchema);

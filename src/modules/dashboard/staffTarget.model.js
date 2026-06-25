import mongoose from 'mongoose';

const staffTargetSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  date: { type: String, required: true }, // YYYY-MM-DD
  target: { type: Number, required: true },
}, { timestamps: true });

staffTargetSchema.index({ user: 1, date: 1 }, { unique: true });

export default mongoose.model('StaffTarget', staffTargetSchema);

import mongoose from 'mongoose';

const commissionOverrideSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  month: { type: Number, required: true }, // 0-indexed
  year: { type: Number, required: true },
  manualCommission: { type: Number, default: null },
  manualBasePay: { type: Number, default: null },
}, { timestamps: true });

commissionOverrideSchema.index({ user: 1, month: 1, year: 1 }, { unique: true });

export default mongoose.model('CommissionOverride', commissionOverrideSchema);

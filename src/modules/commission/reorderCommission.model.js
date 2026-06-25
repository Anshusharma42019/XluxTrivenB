import mongoose from 'mongoose';

// Tracks commission earned by a staff member when a re-order (sent from follow-up) gets delivered
const reorderCommissionSchema = new mongoose.Schema({
  // The NEW order that got delivered (the re-order)
  order_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ShiprocketOrder', required: true, index: true },
  // The ORIGINAL order that completed follow-ups and was sent to verification
  source_order_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ShiprocketOrder' },
  // The lead linking both orders
  lead_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', index: true },
  // Staff who handled the re-verification and whose order got delivered
  staff_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  // 'original' = Staff A (pehli delivery), 'reorder' = Staff B (re-verification delivery)
  commission_role: { type: String, enum: ['original', 'reorder'], required: true },
  // Commission details
  commission_amount: { type: Number, required: true },
  commission_type: { type: String, enum: ['flat', 'percent'], default: 'flat' },
  order_sub_total: { type: Number, default: 0 },
  // Status
  status: { type: String, enum: ['pending', 'paid'], default: 'pending', index: true },
  paid_at: { type: Date },
  paid_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  month: { type: Number }, // 0-indexed month of delivery
  year: { type: Number },
  note: { type: String, default: '' },
}, { timestamps: true });

reorderCommissionSchema.index({ staff_id: 1, month: 1, year: 1 });
// Unique per order + role (one record for Staff A, one for Staff B)
reorderCommissionSchema.index({ order_id: 1, commission_role: 1 }, { unique: true });

export default mongoose.model('ReorderCommission', reorderCommissionSchema);

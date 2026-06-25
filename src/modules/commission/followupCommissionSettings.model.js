import mongoose from 'mongoose';

const priceSlabSchema = new mongoose.Schema({
  min_price:  { type: Number, required: true }, // order sub_total >= min_price
  max_price:  { type: Number, default: null },  // null = no upper limit
  label:      { type: String, default: '' },    // e.g. "₹0–₹500"
  // Staff B (re-verification)
  reorder_commission_amount:  { type: Number, default: 0 },
  reorder_commission_percent: { type: Number, default: 0 },
  // Staff A (original delivery)
  original_staff_commission_amount:  { type: Number, default: 0 },
  original_staff_commission_percent: { type: Number, default: 0 },
}, { _id: false });

const followupCommissionSettingsSchema = new mongoose.Schema({
  commission_type: { type: String, enum: ['flat', 'percent'], default: 'flat' },

  // Global fallback (used when no slab matches)
  reorder_commission_amount:  { type: Number, default: 0 },
  reorder_commission_percent: { type: Number, default: 0 },
  original_staff_commission_amount:  { type: Number, default: 0 },
  original_staff_commission_percent: { type: Number, default: 0 },

  // Price-based slabs (optional — overrides global if order price falls in range)
  price_slabs: { type: [priceSlabSchema], default: [] },

  is_active:   { type: Boolean, default: true },
  updated_by:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

export default mongoose.model('FollowupCommissionSettings', followupCommissionSettingsSchema);

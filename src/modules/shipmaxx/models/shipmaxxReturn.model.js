import mongoose from 'mongoose';

const shipmaxxReturnSchema = new mongoose.Schema({
  order_id: { type: String, unique: true, index: true },
  awb_code: String,
  status: String,
  return_reason: String,
  customer_name: String,
  customer_phone: String,
  customer_address: String,
  lead_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', index: true },
  status_updated_at: { type: Date, index: true },
  order_date: { type: Date, index: true },
}, { timestamps: true });

export const ShipmaxxReturn = mongoose.model('ShipmaxxReturn', shipmaxxReturnSchema);
export default ShipmaxxReturn;

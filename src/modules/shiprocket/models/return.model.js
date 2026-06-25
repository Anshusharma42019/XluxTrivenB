import mongoose from 'mongoose';

const returnSchema = new mongoose.Schema({
  shiprocket_order_id: { type: Number },
  shiprocket_shipment_id: Number,
  order_id: { type: String, index: true },
  awb_code: { type: String, default: '' },
  courier_name: { type: String, default: '' },
  billing_customer_name: { type: String, default: '' },
  billing_phone: { type: String, default: '' },
  sub_total: { type: Number, default: 0 },
  payment_method: { type: String, default: '' },
  status: { type: String, default: 'RTO_INITIATED', index: true },
  return_reason: { type: String, default: '' },
  return_date: { type: Date, default: Date.now },
  lead_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', index: true },
  raw_response: mongoose.Schema.Types.Mixed,
}, { timestamps: true });

export const Return = mongoose.model('ShiprocketReturn', returnSchema);
export default Return;

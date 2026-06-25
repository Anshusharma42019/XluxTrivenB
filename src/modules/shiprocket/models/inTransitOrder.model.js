import mongoose from 'mongoose';

const inTransitOrderSchema = new mongoose.Schema({
  order_id: { type: String, index: true },
  shiprocket_order_id: { type: Number },
  shiprocket_shipment_id: { type: Number },
  billing_customer_name: { type: String, default: '' },
  billing_phone: { type: String, default: '' },
  billing_city: { type: String, default: '' },
  billing_state: { type: String, default: '' },
  billing_pincode: { type: String, default: '' },
  awb_code: { type: String, default: '' },
  courier_name: { type: String, default: '' },
  payment_method: { type: String, default: '' },
  sub_total: { type: Number, default: 0 },
  order_items: [{ name: String, sku: String, units: Number, selling_price: Number }],
  status: { type: String, default: 'IN_TRANSIT', index: true },
  lead_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', default: null },
  status_updated_at: { type: Date, default: null },
  order_date: { type: Date, default: null },
}, { timestamps: true });

inTransitOrderSchema.index({ status_updated_at: -1 });

export const InTransitOrder = mongoose.model('InTransitOrder', inTransitOrderSchema);
export default InTransitOrder;

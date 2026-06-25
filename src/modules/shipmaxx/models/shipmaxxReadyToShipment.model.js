import mongoose from 'mongoose';

const orderItemSchema = new mongoose.Schema({
  name: String, sku: String, units: Number,
  selling_price: mongoose.Schema.Types.Mixed,
  discount: String, tax: String, hsn: String,
}, { _id: false });

const shipmaxxReadyToShipmentSchema = new mongoose.Schema({
  order_id: { type: String, unique: true, index: true },
  billing_customer_name: String,
  billing_phone: String,
  billing_city: String,
  billing_state: String,
  billing_pincode: mongoose.Schema.Types.Mixed,
  payment_method: String,
  sub_total: Number,
  order_items: [orderItemSchema],
  status: { type: String, default: 'READY_TO_SHIP' },
  lead_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', index: true },
  status_updated_at: { type: Date, index: true },
  order_date: { type: Date, index: true },
  problem: { type: String, default: '' },
  notes: { type: String, default: '' },
  comments: [{
    text: { type: String, required: true },
    type: { type: String, enum: ['general', 'followup'], default: 'general' },
    section: { type: String, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdAt: { type: Date, default: Date.now },
  }],
}, { timestamps: true });

export const ShipmaxxReadyToShipment = mongoose.model('ShipmaxxReadyToShipment', shipmaxxReadyToShipmentSchema);
export default ShipmaxxReadyToShipment;

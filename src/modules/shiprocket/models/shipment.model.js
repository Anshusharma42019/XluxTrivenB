import mongoose from 'mongoose';

const shipmentSchema = new mongoose.Schema({
  shiprocket_shipment_id: { type: Number, unique: true, index: true },
  shiprocket_order_id: { type: Number, index: true },
  order_id: { type: String, index: true },
  awb_code: String,
  courier_id: Number,
  courier_name: String,
  status: { type: String, default: 'PENDING' },
  pickup_scheduled_date: String,
  pickup_token_number: String,
  manifest_url: String,
  label_url: String,
  raw_response: mongoose.Schema.Types.Mixed,
}, { timestamps: true });

export const Shipment = mongoose.model('ShiprocketShipment', shipmentSchema);

import mongoose from 'mongoose';

const trackingLogSchema = new mongoose.Schema({
  awb_code: { type: String, index: true },
  shipment_id: { type: Number, index: true },
  order_id: String,
  current_status: String,
  current_status_id: Number,
  shipment_track: mongoose.Schema.Types.Mixed,
  shipment_track_activities: mongoose.Schema.Types.Mixed,
  raw_response: mongoose.Schema.Types.Mixed,
}, { timestamps: true });

export const TrackingLog = mongoose.model('TrackingLog', trackingLogSchema);

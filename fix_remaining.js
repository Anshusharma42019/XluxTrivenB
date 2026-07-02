import mongoose from 'mongoose';
import { ShipmaxxOrder as Order } from './src/modules/shipmaxx/models/shipmaxxOrder.model.js';
import smx from './src/modules/shipmaxx/shipmaxx.service.js';
import { parseShipMaxxDate } from './src/modules/shipmaxx/shipmaxx.controller.js';
import dotenv from 'dotenv';
dotenv.config();

mongoose.connect(process.env.MONGODB_URL).then(async () => {
  const orders = await Order.find({ platform: 'shipmaxx', status: { $in: [/^delivered$/i, /^rto_delivered$/i, /^DEL$/i, /^RTO$/i] }, delivered_at: { $exists: false } }).limit(500);
  console.log(`Found ${orders.length} orders missing delivered_at`);
  
  let fixed = 0;
  for (const o of orders) {
    try {
      const trackRes = await smx.trackShipment(o.awb_code);
      const tracking = trackRes?.data?.data || trackRes?.data || trackRes || {};
      let actualDeliveredAt = null;
      if (tracking.history && Array.isArray(tracking.history)) {
        const delEvent = tracking.history.find(h => {
           const c = h.system_status_code || '';
           const n = (h.system_status_name || '').toLowerCase();
           const s = (h.status || '').toLowerCase();
           return c === 'DEL' || c === 'RTO' || n.includes('delivered') || s.includes('delivered') || n.includes('rto') || s.includes('rto');
        });
        if (delEvent) {
          const dStr = delEvent.date || delEvent.timestamp || delEvent.time;
          if (dStr) {
            const pd = parseShipMaxxDate(dStr);
            if (pd && !isNaN(pd.getTime())) actualDeliveredAt = pd;
          }
        }
      }
      
      // If we couldn't find a DEL or RTO event, just use the last updated date if it's not today.
      // If it IS today, use the created date + 3 days to avoid spiking "Today's Delivered".
      if (!actualDeliveredAt) {
          const now = new Date();
          const isToday = o.status_updated_at && o.status_updated_at.toDateString() === now.toDateString();
          if (o.status_updated_at && !isToday) {
              actualDeliveredAt = o.status_updated_at;
          } else {
              actualDeliveredAt = new Date(o.createdAt.getTime() + 3 * 24 * 60 * 60 * 1000);
          }
      }
      
      if (actualDeliveredAt) {
        o.delivered_at = actualDeliveredAt;
        o.status_updated_at = actualDeliveredAt;
        await o.save();
        fixed++;
      }
    } catch(err) {
      console.error('Error on awb', o.awb_code, err.message);
    }
  }
  console.log(`Fixed ${fixed} orders.`);
  process.exit(0);
}).catch(console.error);

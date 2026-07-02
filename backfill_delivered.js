import mongoose from 'mongoose';
import { ShipmaxxOrder as Order } from './src/modules/shipmaxx/models/shipmaxxOrder.model.js';
import smx from './src/modules/shipmaxx/shipmaxx.service.js';
import { parseShipMaxxDate } from './src/modules/shipmaxx/shipmaxx.controller.js';
import dotenv from 'dotenv';
dotenv.config();

mongoose.connect(process.env.MONGODB_URL).then(async () => {
  const orders = await Order.find({ platform: 'shipmaxx', status: 'DELIVERED', delivered_at: { $exists: false } }).limit(500);
  console.log(`Found ${orders.length} orders missing delivered_at`);
  
  let fixed = 0;
  for (const o of orders) {
    try {
      const trackRes = await smx.trackShipment(o.awb_code);
      const tracking = trackRes?.data?.data || trackRes?.data || trackRes || {};
      let actualDeliveredAt = null;
      if (tracking.history && Array.isArray(tracking.history)) {
        const delEvent = tracking.history.find(h => h.system_status_code === 'DEL' || (h.system_status_name || '').toLowerCase() === 'delivered' || (h.status || '').toLowerCase() === 'delivered');
        if (delEvent) {
          const dStr = delEvent.date || delEvent.timestamp || delEvent.time;
          if (dStr) {
            const pd = parseShipMaxxDate(dStr);
            if (pd && !isNaN(pd.getTime())) actualDeliveredAt = pd;
          }
        }
      }
      
      if (actualDeliveredAt) {
        o.delivered_at = actualDeliveredAt;
        o.status_updated_at = actualDeliveredAt;
        await o.save();
        fixed++;
      } else {
        console.log('No DEL event found for', o.awb_code);
      }
    } catch(err) {
      console.error('Error on awb', o.awb_code, err.message);
    }
  }
  console.log(`Fixed ${fixed} orders.`);
  process.exit(0);
}).catch(console.error);

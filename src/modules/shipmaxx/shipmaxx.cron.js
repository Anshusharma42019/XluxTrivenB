import cron from 'node-cron';
import { ShipmaxxOrder as Order } from './models/shipmaxxOrder.model.js';
import smx from './shipmaxx.service.js';
import { normalizeShipmaxxStatus, parseShipMaxxDate, extractStatusUpdatedAt } from './shipmaxx.controller.js';
import { generateReorderCommissions } from '../shiprocket/shiprocket.controller.js';

const initShipmaxxCron = () => {
  // Sync pending orders every 15 minutes
  cron.schedule('*/15 * * * *', async () => {
    console.log('[Cron] Running ShipMaxx auto-sync for recent in-transit orders...');
    try {
      // Find orders that are NOT delivered/cancelled/RTO, created in last 14 days
      const twoWeeksAgo = new Date();
      twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);

      const activeOrders = await Order.find({
        platform: 'shipmaxx',
        createdAt: { $gte: twoWeeksAgo },
        $or: [
          { status: { $not: /^(delivered|rto_delivered|cancelled|canceled)/i } },
          { status: /^(delivered|rto_delivered)/i, delivered_at: { $exists: false } },
          { status: /^(delivered|rto_delivered)/i, delivered_at: null }
        ]
      }).sort({ status_updated_at: 1, createdAt: 1 }).limit(50).lean(); // limit to 50 to avoid timeout

      let updatedCount = 0;
      for (const o of activeOrders) {
        if (!o.awb_code) continue;
        try {
          const trackRes = await smx.trackShipment(o.awb_code);
          const tracking = trackRes?.data?.data || trackRes?.data || trackRes || {};
          const rawStatus = tracking.current_status || tracking.status || tracking.shipment_status || tracking.delivery_status;
          
          if (rawStatus) {
            let status = normalizeShipmaxxStatus(rawStatus);
            let actualUpdatedAt = new Date();
            if (tracking.history && Array.isArray(tracking.history) && tracking.history.length > 0) {
              actualUpdatedAt = extractStatusUpdatedAt(tracking, status);
            }
            const update = { status, status_updated_at: actualUpdatedAt };
            
            if (status === 'DELIVERED') {
              let actualDeliveredAt = null;
              if (tracking.history && Array.isArray(tracking.history)) {
                const delEvent = tracking.history.find(h =>
                  h.system_status_code === 'DEL' ||
                  (h.system_status_name || '').toLowerCase() === 'delivered' ||
                  (h.status || '').toLowerCase() === 'delivered'
                );
                if (delEvent && delEvent.timestamp) {
                  actualDeliveredAt = parseShipMaxxDate(delEvent.timestamp);
                }
              }
              if (actualDeliveredAt) {
                update.delivered_at = actualDeliveredAt;
                update.status_updated_at = actualDeliveredAt;
              } else {
                update.delivered_at = new Date();
              }
            }
            await Order.updateOne({ _id: o._id }, { $set: update });
            if (status !== o.status) updatedCount++;
          }
        } catch (e) {
          console.error('[Cron] ShipMaxx tracking failed for AWB:', o.awb_code, e.message);
        }
      }
      if (updatedCount > 0) {
        await generateReorderCommissions();
      }
      console.log(`[Cron] ShipMaxx auto-sync finished. Checked ${activeOrders.length}, Updated ${updatedCount}.`);
    } catch (error) {
      console.error('[Cron] ShipMaxx auto-sync error:', error.message);
    }
  });
  console.log('[Cron] ShipMaxx auto-sync scheduled (every 15m)');
};

export default initShipmaxxCron;

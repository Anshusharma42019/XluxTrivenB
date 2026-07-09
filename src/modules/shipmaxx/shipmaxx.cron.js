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
      twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 30);

      // 1. Fetch new shipments from ShipMaxx (Auto-sync new orders)
      try {
        const shipRes = await smx.getShipments({ limit: 50, per_page: 50, page: 1 });
        const shipments = shipRes?.data?.data || shipRes?.data || [];
        for (const s of shipments) {
          if (!s.awb && !s.order_id) continue;
          const query = { platform: 'shipmaxx' };
          if (s.order_id) query.order_id = String(s.order_id);
          else query.awb_code = String(s.awb);

          const newStatus = normalizeShipmaxxStatus(s.status);
          const existing = await Order.findOne(query).select('status status_updated_at').lean();
          let statusUpdatedAt = s.date_added ? new Date(s.date_added) : new Date();
          let finalStatus = newStatus;
          
          if (existing) {
            statusUpdatedAt = existing.status_updated_at || statusUpdatedAt;
            if (newStatus === 'UNKNOWN') {
              console.log(`[Cron] ShipMaxx order ${s.awb || s.order_id} status is UNKNOWN, skipping update.`);
              continue;
            }
          }
          
          const updateData = {
            order_id: String(s.order_id || s.awb),
            awb_code: String(s.awb || ''),
            status: finalStatus,
            platform: 'shipmaxx',
            payment_method: s.payment_method || '',
            status_updated_at: statusUpdatedAt,
          };
          const courier = s.carrier_name || s.courier_name || s.carrier;
          if (courier) updateData.courier_name = courier;

          if (s.created_at) updateData.createdAt = new Date(s.created_at);
          else if (s.date_added) updateData.createdAt = new Date(s.date_added);
          
          if (s.products && Array.isArray(s.products)) {
            updateData.order_items = s.products.map(p => ({
              name: p.name, sku: p.sku, units: p.quantity
            }));
          }
          await Order.updateWithTransaction(query, { $set: updateData }, { upsert: true }).catch(() => {});
        }
      } catch (err) {
        console.error('[Cron] Error fetching new ShipMaxx shipments:', err.message);
      }

      // 2. Track existing active orders
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
            await Order.updateWithTransaction({ _id: o._id }, { $set: update }).catch(() => {});
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

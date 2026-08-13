import cron from 'node-cron';
import { ShipmaxxOrder as Order } from './models/shipmaxxOrder.model.js';
import smx from './shipmaxx.service.js';
import { normalizeShipmaxxStatus, parseShipMaxxDate, extractStatusUpdatedAt } from './shipmaxx.controller.js';
import { generateReorderCommissions } from '../shiprocket/shiprocket.controller.js';

export const runCronSync = async () => {
  try {
    // Find active orders created since the start of the previous month
    const trackingLimit = new Date();
    trackingLimit.setMonth(trackingLimit.getMonth() - 1);
    trackingLimit.setDate(1);
    trackingLimit.setHours(0, 0, 0, 0);

    // 1. Fetch new shipments from ShipMaxx (Auto-sync new orders)
    try {
      let page = 1;
      let keepFetching = true;
      while (keepFetching && page <= 4) {
        const shipRes = await smx.getShipments({ limit: 50, per_page: 50, page });
        const shipments = shipRes?.data?.data || shipRes?.data || [];
        if (shipments.length === 0) break;
        
        let existingCountInPage = 0;
        
        for (const s of shipments) {
          if (!s.awb && !s.order_id) continue;
          const query = { platform: 'shipmaxx' };
          if (s.order_id) query.order_id = String(s.order_id);
          else query.awb_code = String(s.awb);

          const newStatus = normalizeShipmaxxStatus(s.status);
          const existing = await Order.findOne(query).select('status status_updated_at').lean();
          
          if (existing) {
            existingCountInPage++;
          }
          
          let statusUpdatedAt = s.date_added ? new Date(s.date_added) : new Date();
          let finalStatus = newStatus;
          
          if (existing) {
            statusUpdatedAt = existing.status_updated_at || statusUpdatedAt;
            if (newStatus === 'UNKNOWN') {
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
        
        // If we found that almost all orders in this page already exist, we can stop fetching older pages.
        if (existingCountInPage >= 40) {
           keepFetching = false;
        }
        page++;
      }
    } catch (err) {
      console.error('[Cron] Error fetching new ShipMaxx shipments:', err.message);
    }

    // 2. Track existing active orders
    const activeOrders = await Order.find({
      platform: 'shipmaxx',
      createdAt: { $gte: trackingLimit },
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
          const ndrKw = ['EXCEPTION', 'REFUSED', 'NOT AVAILABLE', 'INCOMPLETE', 'ACTION TAKEN', 'ATTEMPT FAILURE', 'ADDRESS'];
          if (status === 'UNDELIVERED' || status === 'UNDELIVERED_ATTEMPT_FAILURE' || status === 'UNDELIVERED_FAILURE' || (ndrKw.some(k => status.includes(k)) && !status.includes('DELIVERED'))) {
            const a = o.delivery_attempt || 1; status = a === 1 ? 'UNDELIVERED_1ST_ATTEMPT' : a === 2 ? 'UNDELIVERED_2ND_ATTEMPT' : a === 3 ? 'UNDELIVERED_3RD_ATTEMPT' : 'UNDELIVERED';
          }
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
            if (o.lead_id) {
              import('../lead/lead.model.js').then(({ Lead }) => {
                Lead.findByIdAndUpdate(o.lead_id, { status: 'follow_up' }).catch(() => {});
              }).catch(() => {});
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

    // 3. Sync NDR list
    try {
      const ndrRes = await smx.getNdrList({ limit: 1000, per_page: 1000, page: 1 });
      const ndrs = ndrRes?.data?.shipments || ndrRes?.shipments || [];
      for (const ndr of ndrs) {
        if (!ndr.orderId && !ndr.awb) continue;
        const attemptNumber = Number(ndr.attemptNumber) || 1;
        let mappedStatus = attemptNumber === 1 ? 'UNDELIVERED_1ST_ATTEMPT' : attemptNumber === 2 ? 'UNDELIVERED_2ND_ATTEMPT' : attemptNumber === 3 ? 'UNDELIVERED_3RD_ATTEMPT' : 'UNDELIVERED';
        if (ndr.status?.toLowerCase() === 'delivered') mappedStatus = 'DELIVERED';
        else if (ndr.status?.toLowerCase().includes('rto delivered')) mappedStatus = 'RTO_DELIVERED';
        
        const query = { platform: 'shipmaxx' }; 
        if (ndr.orderId) query.order_id = String(ndr.orderId); 
        else query.awb_code = String(ndr.awb);
        
        const existing = await Order.findOne(query);
        let sua = ndr.attemptDate ? parseShipMaxxDate(`${ndr.attemptDate} ${ndr.attemptTime || '00:00:00'}`) : null;
        if (!sua && existing?.status_updated_at) sua = existing.status_updated_at; 
        else if (!sua) sua = new Date();
        
        const ud = { 
            order_id: String(ndr.orderId || ndr.awb), 
            awb_code: String(ndr.awb || ''), 
            delivery_attempt: attemptNumber, 
            status_updated_at: sua, 
            platform: 'shipmaxx' 
        };
        const protectedStatuses = ['DELIVERED', 'RTO_DELIVERED', 'OUT_FOR_DELIVERY'];
        if (!existing || !protectedStatuses.includes(existing.status)) {
            ud.status = mappedStatus;
        }
        if (mappedStatus === 'DELIVERED' || mappedStatus === 'RTO_DELIVERED') {
            ud.delivered_at = sua;
        }
        if (ndr.customer) { 
            if (ndr.customer.name) ud.billing_customer_name = ndr.customer.name; 
            if (ndr.customer.phone) ud.billing_phone = ndr.customer.phone; 
            if (ndr.customer.city) ud.billing_city = ndr.customer.city; 
            if (ndr.customer.state) ud.billing_state = ndr.customer.state; 
        }
        await Order.updateWithTransaction(query, { $set: ud }, { upsert: true }).catch(() => {});
      }
      console.log(`[Cron] NDR done (${ndrs.length} records)`);
    } catch (err) { 
      console.error('[Cron] NDR error:', err.message); 
    }

    // 4. Set auto followups
    try {
      const nfu = await Order.find({ platform: 'shipmaxx', status: /^delivered$/i, auto_followups_set: { $ne: true } }).select('_id delivered_at createdAt').lean();
      if (nfu.length > 0) {
        const { Followup } = await import('./models/shipmaxxFollowup.model.js');
        for (const o of nfu) {
          const total = 5;
          const gap = 6;
          const base = new Date(o.delivered_at || o.createdAt || new Date());
          const ops = Array.from({ length: total }, (_, i) => {
            const scheduled_date = new Date(base);
            scheduled_date.setDate(scheduled_date.getDate() + (i * gap));
            return {
              updateOne: {
                filter: { order_id: o._id, followup_number: i + 1 },
                update: { $setOnInsert: { order_id: o._id, followup_number: i + 1, scheduled_date, status: 'scheduled', completed: false } },
                upsert: true,
              },
            };
          });
          await Followup.bulkWrite(ops);
          await Order.findByIdAndUpdate(o._id, { auto_followups_set: true });
        }
        console.log(`[Cron] Auto-followups set for ${nfu.length} orders`);
      }
    } catch (err) {
      console.error('[Cron] Auto-followups error:', err.message);
    }

  } catch (error) {
    console.error('[Cron] ShipMaxx auto-sync error:', error.message);
  }
};

const initShipmaxxCron = () => {
  // Sync pending orders every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    await runCronSync();
  });
  console.log('[Cron] ShipMaxx auto-sync scheduled (every 5m)');
};

export default initShipmaxxCron;

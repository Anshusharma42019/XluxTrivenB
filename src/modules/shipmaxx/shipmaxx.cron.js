import cron from 'node-cron';
import mongoose from 'mongoose';
import { ShipmaxxOrder as Order } from './models/shipmaxxOrder.model.js';
import smx from './shipmaxx.service.js';
import { normalizeShipmaxxStatus, parseShipMaxxDate, extractStatusUpdatedAt, setAutoFollowUps } from './shipmaxx.controller.js';
import { generateReorderCommissions } from '../shiprocket/shiprocket.controller.js';
import { Lead } from '../lead/lead.model.js';
import { sendWhatsAppMessage } from '../interakt/interakt.service.js';
import { ShipmaxxFollowup as Followup } from './models/shipmaxxFollowup.model.js';

/**
 * Given a customer phone number, find the matching lead and fetch
 * verification staff details (task_created_by, verified_by, verification_id).
 * Returns a partial order update object with CRM fields set.
 */
async function linkCrmFields(phone) {
  const fields = {};
  if (!phone) return fields;

  const cleanPhone = String(phone).replace(/\D/g, '');
  if (cleanPhone.length < 10) return fields;

  // Try exact last-10-digits match first
  const last10 = cleanPhone.slice(-10);
  let lead = await Lead.findOne({
    phone: { $regex: last10, $options: 'i' },
    isDeleted: { $ne: true },
  }).select('_id').lean();

  if (!lead) return fields;

  fields.lead_id = lead._id;

  // Look up the latest verification record for this lead
  try {
    const Verification = mongoose.model('Verification');
    const verif = await Verification.findOne({ lead: lead._id, isDeleted: { $ne: true } })
      .populate('task', 'createdBy')
      .sort({ createdAt: -1 })
      .lean();

    if (verif) {
      fields.verified_by = verif.verifiedBy || verif.assignedTo || null;
      fields.verification_id = verif._id;
      fields.task_created_by = verif.task?.createdBy || null;
    }
  } catch (_) { /* Verification model may not be loaded yet */ }

  return fields;
}

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
          const existing = await Order.findOne(query).select('status status_updated_at lead_id').lean();
          
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

          // For new (or unlinked) orders, resolve lead + CRM staff details from phone
          if (!existing || !existing.lead_id) {
            const phone = s.phone || s.customer_phone || s.billing_phone;
            const crmFields = await linkCrmFields(phone);
            Object.assign(updateData, crmFields);
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

    // 1.5. Fetch new orders from ShipMaxx (Auto-sync new unshipped orders)
    try {
      let page = 1;
      let keepFetching = true;
      while (keepFetching && page <= 4) {
        const ordersRes = await smx.fetchAllOrders({ limit: 50, per_page: 50, page });
        const orders = ordersRes?.data?.data || ordersRes?.data || ordersRes?.orders || [];
        if (orders.length === 0) break;
        
        let existingCountInPage = 0;
        
        for (const o of orders) {
          if (!o.order_id) continue;
          const query = { platform: 'shipmaxx', order_id: String(o.order_id) };
          const existing = await Order.findOne(query).select('status lead_id').lean();
          
          if (existing) {
            existingCountInPage++;
          }
          
          const ud = {
            platform: 'shipmaxx',
            billing_customer_name: o.customer_name || '',
            billing_phone: o.phone || '',
            billing_address: o.address || '',
            billing_pincode: o.billing_zip || o.shipping_zip || '',
            sub_total: Number(o.total_price) || 0
          };
          const c = o.carrier_name || o.courier_name || o.carrier;
          if (c) ud.courier_name = c;
          if (o.created_at) ud.createdAt = new Date(o.created_at);
          if (o.awb) ud.awb_code = String(o.awb);
          
          if (o.status) {
            ud.status = normalizeShipmaxxStatus(o.status);
          }
          
          if (o.order_products && Array.isArray(o.order_products)) {
            ud.order_items = o.order_products.map(p => ({
              name: p.title || p.name || '',
              sku: p.sku || '',
              units: Number(p.quantity) || 1,
              selling_price: Number(p.price) || 0
            }));
          }

          // For new (or unlinked) orders, resolve lead + CRM staff details from phone
          if (!existing || !existing.lead_id) {
            const phone = o.phone || o.customer_phone;
            const crmFields = await linkCrmFields(phone);
            Object.assign(ud, crmFields);
          }
          
          await Order.updateWithTransaction(query, { $set: ud }, { upsert: true }).catch(() => {});
        }
        
        if (existingCountInPage >= 40) {
           keepFetching = false;
        }
        page++;
      }
      console.log(`[Cron] Fetching new orders done`);
    } catch (err) {
      console.error('[Cron] Error fetching new ShipMaxx orders:', err.message);
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

          // ── Real-time WhatsApp + Followups on first DELIVERED detection ──────
          if (status === 'DELIVERED' && o.status !== 'DELIVERED') {
            if (!o.auto_followups_set) {
              await setAutoFollowUps(o._id, update.delivered_at || new Date()).catch(err => {
                console.error('[ShipMaxx Cron] Failed to set auto followups:', err.message);
              });
            }
          }

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

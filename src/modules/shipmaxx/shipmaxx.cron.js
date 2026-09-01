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
          const existing = await Order.findOne(query).select('status status_updated_at lead_id payment_method courier_name order_items createdAt').lean();
          
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
            platform: 'shipmaxx',
            status_updated_at: statusUpdatedAt,
          };

          const isGenericUndelivered = (st) => /^(undelivered|undelivered_attempt_failure|undelivered_failure)$/i.test(st);
          const isSpecificUndelivered = (st) => /^undelivered_\d(st|nd|rd)_attempt$/i.test(st);
          let shouldUpdateStatus = true;
          const protectedStatuses = ['DELIVERED', 'RTO_DELIVERED'];
          if (existing) {
            if (protectedStatuses.includes(existing.status)) {
              shouldUpdateStatus = false;
            } else if (isSpecificUndelivered(existing.status) && isGenericUndelivered(finalStatus)) {
              shouldUpdateStatus = false;
            }
          }
          if (shouldUpdateStatus) {
            updateData.status = finalStatus;
          }

          if (s.payment_method && (!existing || !existing.payment_method)) {
            updateData.payment_method = s.payment_method;
          }

          const courier = s.carrier_name || s.courier_name || s.carrier;
          if (courier && (!existing || !existing.courier_name)) {
            updateData.courier_name = courier;
          }

          if (!existing) {
            if (s.created_at) updateData.createdAt = new Date(s.created_at);
            else if (s.date_added) updateData.createdAt = new Date(s.date_added);
          }
          
          if (s.products && Array.isArray(s.products) && (!existing || !existing.order_items || existing.order_items.length === 0)) {
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
          const existing = await Order.findOne(query).select('status lead_id billing_customer_name billing_phone billing_address billing_pincode sub_total courier_name awb_code order_items createdAt').lean();
          
          if (existing) {
            existingCountInPage++;
          }
          
          const ud = {
            platform: 'shipmaxx',
            order_id: String(o.order_id)
          };
          if (o.customer_name && (!existing || !existing.billing_customer_name)) ud.billing_customer_name = o.customer_name;
          if (o.phone && (!existing || !existing.billing_phone)) ud.billing_phone = o.phone;
          if (o.address && (!existing || !existing.billing_address)) ud.billing_address = o.address;
          const zip = o.billing_zip || o.shipping_zip;
          if (zip && (!existing || !existing.billing_pincode)) ud.billing_pincode = zip;
          if (o.total_price && (!existing || !existing.sub_total)) ud.sub_total = Number(o.total_price) || 0;

          const c = o.carrier_name || o.courier_name || o.carrier;
          if (c && (!existing || !existing.courier_name)) ud.courier_name = c;
          if (!existing && o.created_at) ud.createdAt = new Date(o.created_at);
          if (o.awb && (!existing || !existing.awb_code)) ud.awb_code = String(o.awb);
          
          if (o.status) {
            const newStatus = normalizeShipmaxxStatus(o.status);
            const isGenericUndelivered = (st) => /^(undelivered|undelivered_attempt_failure|undelivered_failure)$/i.test(st);
            const isSpecificUndelivered = (st) => /^undelivered_\d(st|nd|rd)_attempt$/i.test(st);
            let shouldUpdateStatus = true;
            const protectedStatuses = ['DELIVERED', 'RTO_DELIVERED'];
            if (existing) {
              if (protectedStatuses.includes(existing.status)) {
                shouldUpdateStatus = false;
              } else if (isSpecificUndelivered(existing.status) && isGenericUndelivered(newStatus)) {
                shouldUpdateStatus = false;
              }
            }
            if (shouldUpdateStatus) {
              ud.status = newStatus;
            }
          }
          
          if (o.order_products && Array.isArray(o.order_products) && (!existing || !existing.order_items || existing.order_items.length === 0)) {
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

    const activeOrders = await Order.find({
      platform: 'shipmaxx',
      createdAt: { $gte: trackingLimit },
      $or: [
        { status: { $not: /^(delivered|rto_delivered|cancelled|canceled)/i } },
        { status: /^(delivered|rto_delivered)/i, delivered_at: { $exists: false } },
        { status: /^(delivered|rto_delivered)/i, delivered_at: null }
      ]
    }).sort({ status_updated_at: 1, createdAt: 1 }).limit(20).lean(); // limit to 20 for fast response (<15s)

    let updatedCount = 0;
    for (const o of activeOrders) {
      if (!o.awb_code) continue;
      try {
        const trackRes = await smx.trackShipment(o.awb_code);
        
        // Wait 500ms before the next tracking request to respect API rate limits
        await new Promise(resolve => setTimeout(resolve, 500));
        
        const tracking = trackRes?.data?.data || trackRes?.data || trackRes || {};
        const rawStatus = tracking.current_status || tracking.status || tracking.shipment_status || tracking.delivery_status || tracking.history?.[0]?.system_status_name || tracking.history?.[0]?.system_status_code || tracking.history?.[0]?.status;
        
        if (rawStatus) {
          let status = normalizeShipmaxxStatus(rawStatus);
          const ndrKw = ['EXCEPTION', 'REFUSED', 'NOT AVAILABLE', 'INCOMPLETE', 'ACTION TAKEN', 'ATTEMPT FAILURE', 'ADDRESS'];
          if (status === 'UNDELIVERED' || status === 'UNDELIVERED_ATTEMPT_FAILURE' || status === 'UNDELIVERED_FAILURE' || (ndrKw.some(k => status.includes(k)) && !status.includes('DELIVERED'))) {
            const a = o.delivery_attempt || 1; status = a === 1 ? 'UNDELIVERED_1ST_ATTEMPT' : a === 2 ? 'UNDELIVERED_2ND_ATTEMPT' : a === 3 ? 'UNDELIVERED_3RD_ATTEMPT' : 'UNDELIVERED';
          }

          // Only compute a new status_updated_at when the status has actually changed.
          // If status is unchanged, preserve the existing DB timestamp so that the order
          // does NOT get stamped with today's date on every cron run (which was causing
          // all active orders to appear in the "TODAY" date filter even if created days ago).
          const statusChanged = status !== o.status;
          let actualUpdatedAt;
          if (statusChanged) {
            // Status changed — derive the real timestamp from tracking history
            if (tracking.history && Array.isArray(tracking.history) && tracking.history.length > 0) {
              actualUpdatedAt = extractStatusUpdatedAt(tracking, status);
            } else {
              // No history available — use now as best approximation
              actualUpdatedAt = new Date();
            }
          } else {
            // Status unchanged — keep existing timestamp, do NOT re-stamp with today
            actualUpdatedAt = o.status_updated_at || new Date();
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
  // Sync pending orders every 2 minutes
  cron.schedule('*/2 * * * *', async () => {
    await runCronSync();
  });
  console.log('[Cron] ShipMaxx auto-sync scheduled (every 2m)');
};

export default initShipmaxxCron;

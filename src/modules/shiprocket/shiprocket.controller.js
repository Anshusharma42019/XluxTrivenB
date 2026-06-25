import catchAsync from '../../utils/catchAsync.js';
import ApiResponse from '../../utils/ApiResponse.js';
import sr from './shiprocket.service.js';
import { getNextOrderId, peekNextOrderId } from './counter/counter.model.js';
import { Order } from './models/order.model.js';
import { Followup } from './models/followup.model.js';
import { Shipment } from './models/shipment.model.js';
import { TrackingLog } from './models/trackingLog.model.js';
import { Return } from './models/return.model.js';
import { WalletTransaction } from './models/walletTransaction.model.js';
import { DeliveredOrder } from './models/deliveredOrder.model.js';
import { InTransitOrder } from './models/inTransitOrder.model.js';
import ReadyToShipment from '../readytoshipment/readytoshipment.model.js';
import { Lead } from '../lead/lead.model.js';
import Task from '../task/task.model.js';
import Verification from '../verification/verification.model.js';
import FollowupCommissionSettings from '../commission/followupCommissionSettings.model.js';
import ReorderCommission from '../commission/reorderCommission.model.js';

const DEFAULT_FOLLOWUP_TOTAL = 5;
const DEFAULT_FOLLOWUP_GAP_DAYS = 6;

const getFollowupSettings = () => ({ total_followups: DEFAULT_FOLLOWUP_TOTAL, followup_gap_days: DEFAULT_FOLLOWUP_GAP_DAYS });
const logOrderActivity = async () => null;

const parseAmount = (value) => {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const cleaned = String(value).replace(/[^\d.-]/g, '');
  const amount = Number(cleaned);
  return Number.isFinite(amount) ? amount : 0;
};

const getOrderAmount = (order = {}, itemsTotal = 0) => {
  const moneyFields = [
    order.sub_total,
    order.order_total,
    order.amount,
    order.price,
    order.total_amount,
    order.total_price,
    order.grand_total,
  ].map(parseAmount);

  const moneyAmount = moneyFields.find(amount => amount > 0);
  if (moneyAmount) return moneyAmount;

  // Shiprocket's `total` can be a count-like field in some responses, so use it only as a last resort.
  return itemsTotal || parseAmount(order.total) || 0;
};

// Cleanup: Remove pending commissions if order is no longer delivered
const cleanupReorderCommissions = async () => {
  try {
    const pendingComms = await ReorderCommission.find({ status: 'pending' }).populate('order_id', 'status').lean();
    const toDelete = pendingComms.filter(c => {
      const status = (c.order_id?.status || '').toUpperCase();
      return status !== 'DELIVERED';
    }).map(c => c._id);

    if (toDelete.length > 0) {
      await ReorderCommission.deleteMany({ _id: { $in: toDelete } });
      console.log(`[Commission] Cleaned up ${toDelete.length} invalid pending commissions`);
    }
  } catch (e) {
    console.error('[Commission] cleanup error:', e.message);
  }
};

// Generate commission for re-orders (orders from follow-up → verification → new delivery)
const generateReorderCommissions = async () => {
  try {
    await cleanupReorderCommissions();

    const settings = await FollowupCommissionSettings.findOne().sort({ createdAt: -1 }).lean();
    if (!settings || !settings.is_active) return;

    // Find all delivered orders that haven't had commission generated yet
    const pendingOrders = await Order.find({
      status: { $in: ['DELIVERED', 'Delivered', 'delivered'] },
      reorder_commission_generated: { $ne: true },
    }).populate('lead_id').lean();

    const reorders = [];
    for (const o of pendingOrders) {
      if (o.source_order_id || o.lead_id?.status === 'old') {
        reorders.push(o);
      }
    }

    for (const order of reorders) {
      const deliveredAt = order.delivered_at || order.createdAt || new Date();
      const month = deliveredAt.getMonth();
      const year = deliveredAt.getFullYear();

      // ── Staff B: re-verification staff / current order staff ──────────
      let staffB = order.verified_by || order.created_by;
      if (!staffB && order.lead_id) {
        staffB = order.lead_id.assignedTo || order.lead_id.createdBy;
      }

      // ── Staff A: original order staff (created_by on source order or original lead creator) ─────────
      let staffA = null;
      if (order.source_order_id) {
        const sourceOrder = await Order.findById(order.source_order_id).select('created_by verified_by lead_id').lean();
        staffA = sourceOrder?.created_by || sourceOrder?.verified_by;
        if (!staffA && sourceOrder?.lead_id) {
          const srcLead = await Lead.findById(sourceOrder.lead_id).select('assignedTo createdBy').lean();
          staffA = srcLead?.assignedTo || srcLead?.createdBy;
        }
      } else if (order.lead_id?.status === 'old') {
        staffA = order.lead_id.createdBy || order.lead_id.assignedTo;
      }

      const calcAmount = (isOriginal) => {
        // Find matching price slab first
        const price = order.sub_total || 0;
        const slab = (settings.price_slabs || []).find(s =>
          price >= s.min_price && (s.max_price === null || s.max_price === undefined || price <= s.max_price)
        );
        const src = slab || settings; // fallback to global if no slab matches
        const amt = isOriginal ? src.original_staff_commission_amount : src.reorder_commission_amount;
        const pct = isOriginal ? src.original_staff_commission_percent : src.reorder_commission_percent;
        return settings.commission_type === 'percent' ? (price * pct) / 100 : amt;
      };

      const base = {
        source_order_id: order.source_order_id || order._id,
        lead_id: order.lead_id?._id || order.lead_id || null,
        commission_type: settings.commission_type,
        order_sub_total: order.sub_total || 0,
        status: 'pending',
        month,
        year,
      };

      // Create Staff B commission (re-verification)
      if (staffB) {
        const amountB = calcAmount(false);
        if (amountB > 0) {
          await ReorderCommission.findOneAndUpdate(
            { order_id: order._id, commission_role: 'reorder' },
            { $setOnInsert: { ...base, order_id: order._id, staff_id: staffB, commission_amount: amountB, commission_role: 'reorder' } },
            { upsert: true }
          );
        }
      }

      // Create Staff A commission (original delivery)
      if (staffA && String(staffA) !== String(staffB)) {
        const amountA = calcAmount(true);
        if (amountA > 0) {
          await ReorderCommission.findOneAndUpdate(
            { order_id: order._id, commission_role: 'original' },
            { $setOnInsert: { ...base, order_id: order._id, staff_id: staffA, commission_amount: amountA, commission_role: 'original' } },
            { upsert: true }
          );
        }
      }

      await Order.findByIdAndUpdate(order._id, { reorder_commission_generated: true });
    }
  } catch (e) {
    console.error('[Commission] generateReorderCommissions error:', e.message);
  }
};


// ── Auth ──────────────────────────────────────────────────────────────────────
export const login = catchAsync(async (req, res) => {
  const token = await sr.login();
  res.json(new ApiResponse(200, { token }, 'Shiprocket login successful'));
});

// ── Order ID helpers ──────────────────────────────────────────────────────────
export const nextOrderId = catchAsync(async (req, res) => {
  const order_id = await peekNextOrderId();
  res.json(new ApiResponse(200, { order_id }, 'Next order ID'));
});

// ── Orders ────────────────────────────────────────────────────────────────────
export const createOrder = catchAsync(async (req, res) => {
  const body = { ...req.body };
  delete body.token;

  const required = ['billing_customer_name', 'billing_address', 'billing_city', 'billing_pincode', 'billing_state', 'billing_phone'];
  const missing = required.filter((k) => !body[k]);
  if (missing.length) return res.json(new ApiResponse(400, null, `Missing: ${missing.join(', ')}`));

  // Validate phone — must be exactly 10 digits
  const phone = String(body.billing_phone).replace(/\D/g, '');
  if (phone.length !== 10) {
    return res.json(new ApiResponse(400, null, `billing_phone must be exactly 10 digits (got ${phone.length})`));
  }

  // order_date must be "YYYY-MM-DD HH:mm" format
  const rawDate = body.order_date || new Date().toISOString().split('T')[0];
  const order_date = rawDate.includes(' ') ? rawDate : `${rawDate} 10:00`;

  const order_items = (body.order_items || []).map((i) => ({
    name: String(i.name || ''),
    sku: String(i.sku || ''),
    units: Number(i.units) || 1,
    selling_price: Number(i.selling_price) || 0,
    discount: String(i.discount || '0'),
    tax: String(i.tax || ''),
    hsn: String(i.hsn || ''),
  }));

  if (!order_items.length || !order_items[0].name) {
    return res.json(new ApiResponse(400, null, 'order_items must have at least one item with a name'));
  }

  // Always use a fresh auto-generated order_id — never reuse one
  const order_id = await getNextOrderId();

  const payload = {
    order_id,
    order_date,
    pickup_location: body.pickup_location || 'Primary',
    comment: body.comment || '',
    billing_customer_name: String(body.billing_customer_name),
    billing_last_name: String(body.billing_last_name || ''),
    billing_address: String(body.billing_address),
    billing_address_2: String(body.billing_address_2 || ''),
    billing_city: String(body.billing_city),
    billing_pincode: String(body.billing_pincode),
    billing_state: String(body.billing_state),
    billing_country: String(body.billing_country || 'India'),
    billing_email: String(body.billing_email || ''),
    billing_phone: phone,
    billing_alternate_phone: String(body.billing_alternate_phone || ''),
    shipping_is_billing: 1,
    shipping_customer_name: String(body.billing_customer_name),
    shipping_last_name: String(body.billing_last_name || ''),
    shipping_address: String(body.billing_address),
    shipping_address_2: String(body.billing_address_2 || ''),
    shipping_city: String(body.billing_city),
    shipping_pincode: String(body.billing_pincode),
    shipping_country: String(body.billing_country || 'India'),
    shipping_state: String(body.billing_state),
    shipping_email: String(body.billing_email || ''),
    shipping_phone: phone,
    order_items,
    payment_method: body.payment_method || 'prepaid',
    sub_total: Number(body.sub_total) || 0,
    length: Number(body.length) || 10,
    breadth: Number(body.breadth) || 10,
    height: Number(body.height) || 10,
    weight: Number(body.weight) || 0.5,
  };

  const data = await sr.createOrder(payload);

  // Persist to MongoDB
  const savedOrder = await Order.findOneAndUpdate(
    { order_id: payload.order_id },
    {
      ...payload,
      shiprocket_order_id: data?.order_id,
      shiprocket_shipment_id: data?.shipment_id,
      status: data?.status || 'NEW',
      status_code: data?.status_code,
      lead_id: body.lead_id || undefined,
      created_by: req.user?._id,
      raw_response: data,
    },
    { upsert: true, returnDocument: 'after' }
  );

  // If this lead had a pending re-order source (from follow-up cycle), link it and clear the flag
  if (body.lead_id && savedOrder) {
    const lead = await Lead.findById(body.lead_id).select('pending_reorder_source pending_reorder_staff').lean();
    if (lead?.pending_reorder_source) {
      await Order.findByIdAndUpdate(savedOrder._id, {
        source_order_id: lead.pending_reorder_source,
        verified_by: lead.pending_reorder_staff || req.user?._id,
      });
      await Lead.findByIdAndUpdate(body.lead_id, { $unset: { pending_reorder_source: 1, pending_reorder_staff: 1 } });
    }
  }

  await logOrderActivity({
    orderId: savedOrder?._id,
    actor: req.user?._id,
    type: 'order_created',
    title: 'Order Created',
    description: `Order ${payload.order_id} created`,
  });

  // Remove from Ready to Shipment list once order is created
  if (body.lead_id) {
    await ReadyToShipment.findOneAndUpdate({ lead: body.lead_id }, { sentToShiprocket: true });
  }

  res.json(new ApiResponse(200, data, 'Order created'));
});

export const updateOrder = catchAsync(async (req, res) => {
  const { token, ...body } = req.body;
  if (!body.order_id) return res.json(new ApiResponse(400, null, 'order_id is required'));
  if (body.order_date && !body.order_date.includes(' ')) {
    body.order_date = `${body.order_date} 10:00`;
  }
  const data = await sr.updateOrder(body);
  await Order.findOneAndUpdate(
    { $or: [{ shiprocket_order_id: Number(body.order_id) }, { order_id: String(body.order_id) }] },
    { raw_response: data },
    { returnDocument: 'after' }
  );
  res.json(new ApiResponse(200, data, 'Order updated'));
});

export const cancelOrders = catchAsync(async (req, res) => {
  const { ids } = req.body;
  const data = await sr.cancelOrders(ids);
  res.json(new ApiResponse(200, data, 'Orders cancelled'));
});

export const deleteLocalOrder = catchAsync(async (req, res) => {
  const { id } = req.params;
  await Order.findOneAndDelete({ $or: [{ order_id: id }, { shiprocket_order_id: Number(id) }] });
  res.json(new ApiResponse(200, null, 'Order deleted from local DB'));
});

export const getOrders = catchAsync(async (req, res) => {
  const params = {};
  if (req.query.from) params.from = req.query.from;
  if (req.query.to) params.to = req.query.to;
  if (req.query.page) params.page = req.query.page;
  if (req.query.per_page) params.per_page = req.query.per_page;
  const data = await sr.getOrders(params);
  res.json(new ApiResponse(200, data, 'Orders fetched'));
});

// ── Sync all Shiprocket data into local DB ────────────────────────────────────
const toList = (raw) => {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  const vals = Object.values(raw);
  return vals.every(v => v && typeof v === 'object') ? vals : [];
};

// Normalize Shiprocket status: uppercase, spaces+hyphens → underscore, merge IN_TRANSIT variants
const normalizeOrderStatus = (status) => {
  if (!status) return 'NEW';
  const s = status.toUpperCase().replace(/[\s-]+/g, '_');
  if (s.startsWith('IN_TRANSIT')) return 'IN_TRANSIT';
  return s;
};

const syncAllToLocal = async () => {
  const allLeads = await Lead.find({ isDeleted: { $ne: true } }).select('name phone email address pincode').lean();
  const byName = {};
  const byPincode = {};
  const pincodeCount = {};

  for (const l of allLeads) {
    const full = (l.name || '').toLowerCase().trim();
    byName[full] = l;
    const pin = l.pincode || (l.address || '').match(/\b(\d{6})\b/)?.[1];
    if (pin) {
      pincodeCount[pin] = (pincodeCount[pin] || 0) + 1;
      byPincode[pin] = l;
    }
  }
  for (const pin of Object.keys(pincodeCount)) {
    if (pincodeCount[pin] > 1) delete byPincode[pin];
  }

  const findLead = (name, pincode, maskedPhone) => {
    const digits = String(maskedPhone || '').replace(/\D/g, '');
    if (digits.length >= 10 && !/^x+$/i.test(maskedPhone)) {
      const match = allLeads.find(l => String(l.phone).replace(/\D/g, '').includes(digits));
      if (match) return match;
    }
    const full = (name || '').toLowerCase().trim();
    const pin = String(pincode || '').trim();
    let match = byName[full];
    if (!match) {
      const words = full.split(/\s+/).filter(w => w.length > 2);
      if (words.length > 0) {
        match = Object.entries(byName).find(([k]) => words.every(w => k.includes(w)))?.[1];
      }
    }
    if (!match && pin) match = byPincode[pin];
    return match;
  };

  let page = 1, totalSynced = 0;
  for (;;) {
    const data = await sr.getOrders({ per_page: 100, page });
    const list = toList(data?.data);
    if (!list.length) break;
    const trackableStatuses = ['OUT_FOR_DELIVERY', 'RTO_OFD', 'IN_TRANSIT', 'RTO_IN_TRANSIT', 'PICKUP_SCHEDULED'];
    const activeOrders = list.filter(o => trackableStatuses.includes(normalizeOrderStatus(o.status)) && o.shipments?.[0]?.awb);
    let trackingMap = {};
    if (activeOrders.length > 0) {
      try {
        // Shiprocket limits bulk tracking to 50 AWBs per request
        const awbs = activeOrders.slice(0, 50).map(o => o.shipments[0].awb);
        const trackingRes = await sr.trackBulk(awbs);
        // The response might be in tracking_data or the root object depending on API version
        trackingMap = trackingRes?.tracking_data || trackingRes || {};
      } catch (e) {
        console.error('[Sync] bulk track error:', e.message);
      }
    }

    await Promise.all(list.map(async (o) => {
      const srId = Number(o.id);
      const shipment = o.shipments?.[0];
      const lead = findLead(o.customer_name, o.customer_pincode, o.billing_phone || o.customer_phone);
      const isDelivered = o.status?.toLowerCase() === 'delivered';
      const status = normalizeOrderStatus(o.status);

      const rawDeliveredAt = shipment?.delivered_date || o.delivered_date || o.deliver_date ||
        (isDelivered ? o.updated_at : null);
      const deliveredAt = rawDeliveredAt ? parseShiprocketDate(rawDeliveredAt) : null;

      // Extract precise status update time and attempt number from tracking if available
      let statusUpdatedAt = parseShiprocketDate(o.status_updated_at || o.updated_at || o.created_at);
      let deliveryAttempt = Number(shipment?.attempt_count || o.attempt_count || 1);

      if (trackableStatuses.includes(status) && shipment?.awb) {
        const trackingList = trackingMap?.shipment_track || [];
        const track = trackingList.find(t => String(t.awb_code) === String(shipment.awb));
        const activities = track?.shipment_track_activities || [];

        // Count OFD/Re-attempt occurrences across history to determine attempt number if not provided
        if (deliveryAttempt <= 1) {
          const ofdEvents = activities.filter(a => {
            const act = String(a.activity || '').toLowerCase();
            const stat = String(a.status || '').toUpperCase();
            return stat === 'OFD' || act.includes('out for delivery') || act.includes('re-attempt') || act.includes('undelivered');
          });
          // Unique dates for attempts to avoid double counting same-day logs
          const uniqueDates = new Set(ofdEvents.map(a => String(a.date || '').split(' ')[0]));
          if (uniqueDates.size > 0) deliveryAttempt = uniqueDates.size;
        }

        // Use the absolute latest activity for the timestamp
        if (activities.length > 0) {
          statusUpdatedAt = parseShiprocketDate(activities[0].date);
        }
      }

      // Calculate sub_total from multiple sources for accuracy
      const itemsTotal = (o.products || o.order_items || []).reduce((sum, p) => {
        return sum + (Number(p.selling_price || p.price) || 0) * (Number(p.units || p.quantity) || 1);
      }, 0);
      const sub_total = getOrderAmount(o, itemsTotal);

      // Auto-sort generic undelivered statuses into specific attempt categories for accuracy
      let finalStatus = status;
      if (status === 'UNDELIVERED' || status === 'UNDELIVERED_ATTEMPT_FAILURE' || status === 'UNDELIVERED_FAILURE') {
        if (deliveryAttempt === 1) finalStatus = 'UNDELIVERED_1ST_ATTEMPT';
        else if (deliveryAttempt === 2) finalStatus = 'UNDELIVERED_2ND_ATTEMPT';
        else if (deliveryAttempt >= 3) finalStatus = 'UNDELIVERED_3RD_ATTEMPT';
      }

      const setFields = {
        shiprocket_order_id: srId,
        shiprocket_shipment_id: shipment?.id ? Number(shipment.id) : undefined,
        order_id: String(o.channel_order_id || srId),
        order_date: o.created_at,
        status: finalStatus,
        status_updated_at: statusUpdatedAt,
        delivery_attempt: deliveryAttempt,
        sub_total,
        lead_id: lead?._id,
        billing_customer_name: o.customer_name,
        billing_phone: lead?.phone || (o.billing_phone && !/^x+$/i.test(o.billing_phone) ? o.billing_phone : null) || o.customer_phone,
        billing_email: lead?.email || o.customer_email || o.billing_email,
        billing_address: o.customer_address,
        billing_city: o.customer_city,
        billing_state: o.customer_state,
        billing_pincode: o.customer_pincode,
        billing_country: o.customer_country || 'India',
        awb_code: shipment?.awb,
        courier_id: shipment?.courier_company_id ? Number(shipment.courier_company_id) : undefined,
        courier_name: shipment?.courier,
        payment_method: o.payment_method,
        order_items: (o.products || o.order_items || []).map(p => ({
          name: p.name || p.product_name || '',
          sku: p.sku || '',
          units: Number(p.units || p.quantity) || 1,
          selling_price: Number(p.selling_price || p.price) || 0,
        })),
        raw_response: o,
      };

      if (isDelivered && deliveredAt) setFields.delivered_at = deliveredAt;

      try {
        const existingOrder = await Order.findOne({ shiprocket_order_id: srId }).select('billing_phone').lean();
        const existingPhone = existingOrder?.billing_phone;
        const hasRealPhone = existingPhone && !/^x+$/i.test(existingPhone) && String(existingPhone).replace(/\D/g, '').length >= 10;
        if (hasRealPhone) setFields.billing_phone = existingPhone; // keep real phone, don't overwrite

        await Order.updateOne(
          { shiprocket_order_id: srId },
          { $set: setFields },
          { upsert: true }
        );
      } catch (e) {
        if (e.code === 11000) {
          await Order.updateOne({ shiprocket_order_id: srId }, { $set: setFields });
        } else {
          console.error('[Sync] order error:', srId, e.message);
        }
      }
    }));
    totalSynced += list.length;
    const totalPages = data?.meta?.pagination?.total_pages || 1;
    if (page >= totalPages) break;
    page++;
  }

  // Fix any delivered orders that still have null delivered_at — use createdAt as fallback
  const nullDeliveredOrders = await Order.find({ status: /^delivered$/i, delivered_at: null }).select('_id createdAt').lean();
  await Promise.all(nullDeliveredOrders.map(o => Order.updateOne({ _id: o._id }, { $set: { delivered_at: o.createdAt } })));

  page = 1;
  for (;;) {
    const data = await sr.getShipments({ per_page: 100, page });
    const list = toList(data?.data);
    if (!list.length) break;
    await Promise.all(list.map(async (s) => {
      try {
        await Shipment.updateOne(
          { shiprocket_shipment_id: Number(s.id) },
          { $set: {
            shiprocket_shipment_id: Number(s.id),
            shiprocket_order_id: Number(s.order_id),
            order_id: String(s.channel_order_id || s.order_id),
            awb_code: s.awb_code,
            courier_id: s.courier_id,
            courier_name: s.courier_name || s.courier,
            status: s.status,
            raw_response: s,
          }},
          { upsert: true }
        );
      } catch (e) {
        if (e.code !== 11000) console.error('[Sync] shipment error:', s.id, e.message);
      }
    }));
    const totalPages = data?.meta?.pagination?.total_pages || 1;
    if (page >= totalPages) break;
    page++;
  }

  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const todayEnd = new Date(); todayEnd.setHours(23,59,59,999);
  const deliveredTodayAll = await Order.find({
    status: { $in: ['DELIVERED', 'Delivered'] },
    updatedAt: { $gte: todayStart, $lte: todayEnd },
  }).select('lead_id billing_customer_name billing_phone billing_pincode').lean();

  for (const o of deliveredTodayAll) {
    let leadId = o.lead_id;
    if (!leadId && o.billing_phone && !/^x+$/i.test(o.billing_phone)) {
      const lead = await Lead.findOne({ phone: o.billing_phone, isDeleted: { $ne: true } }).select('_id status').lean();
      leadId = lead?._id;
    }
    if (leadId) await Lead.findByIdAndUpdate(leadId, { status: 'follow_up' });
  }

  const needsFollowUps = await Order.find({
    status: { $in: ['DELIVERED', 'Delivered'] },
    auto_followups_set: { $ne: true },
  }).select('_id delivered_at createdAt').lean();

  for (const o of needsFollowUps) {
    await setAutoFollowUps(o._id, o.delivered_at || o.createdAt || new Date());
  }

    // Generate re-order commissions for newly delivered orders that came from a follow-up cycle
  await generateReorderCommissions();
};

export const syncShiprocket = catchAsync(async (req, res) => {
  try {
    await syncAllToLocal();
  } catch (e) {
    console.error('[Sync] error:', e.message);
  }

  // Sync delivered orders into DeliveredOrder collection
  try {
    const delivered = await Order.find({ status: /^delivered$/i })
      .select('order_id shiprocket_order_id shiprocket_shipment_id billing_customer_name billing_phone billing_email billing_address billing_city billing_state billing_pincode awb_code courier_name payment_method sub_total order_items status lead_id delivered_at createdAt')
      .lean();
    for (const o of delivered) {
      await DeliveredOrder.findOneAndUpdate(
        { order_id: o.order_id },
        { $set: {
          order_id: o.order_id,
          shiprocket_order_id: o.shiprocket_order_id,
          shiprocket_shipment_id: o.shiprocket_shipment_id,
          billing_customer_name: o.billing_customer_name || '',
          billing_phone: o.billing_phone || '',
          billing_email: o.billing_email || '',
          billing_address: o.billing_address || '',
          billing_city: o.billing_city || '',
          billing_state: o.billing_state || '',
          billing_pincode: o.billing_pincode || '',
          awb_code: o.awb_code || '',
          courier_name: o.courier_name || '',
          payment_method: o.payment_method || '',
          sub_total: o.sub_total || 0,
          order_items: o.order_items || [],
          status: o.status,
          lead_id: o.lead_id || null,
          delivered_at: o.delivered_at || o.createdAt,
          order_date: o.createdAt,
        }},
        { upsert: true }
      );
    }
    console.log('[Sync] delivered orders synced:', delivered.length);
  } catch (e) {
    console.error('[Sync] delivered sync error:', e.message);
  }

  // Sync in-transit orders
  try {
    const active = await Order.find({ status: { $not: /^(delivered|rto)/i } })
      .select('order_id shiprocket_order_id shiprocket_shipment_id billing_customer_name billing_phone billing_city billing_state billing_pincode awb_code courier_name payment_method sub_total order_items status lead_id status_updated_at createdAt').lean();
    for (const o of active) {
      await InTransitOrder.findOneAndUpdate(
        { order_id: o.order_id },
        { $set: { order_id: o.order_id, shiprocket_order_id: o.shiprocket_order_id, billing_customer_name: o.billing_customer_name || '', billing_phone: o.billing_phone || '', billing_city: o.billing_city || '', billing_state: o.billing_state || '', billing_pincode: o.billing_pincode || '', awb_code: o.awb_code || '', courier_name: o.courier_name || '', payment_method: o.payment_method || '', sub_total: o.sub_total || 0, order_items: o.order_items || [], status: o.status, lead_id: o.lead_id || null, status_updated_at: o.status_updated_at || o.createdAt, order_date: o.createdAt }},
        { upsert: true }
      ).catch(() => {});
    }
    await InTransitOrder.deleteMany({ status: { $regex: /^(delivered|rto)/i } }).catch(() => {});
    console.log('[Sync] in-transit orders synced:', active.length);
  } catch (e) {
    console.error('[Sync] in-transit sync error:', e.message);
  }

  res.json(new ApiResponse(200, null, 'Sync complete'));
});

let lastSyncTime = 0;
const SYNC_COOLDOWN_MS = 5 * 60 * 1000;

export const getInTransitOrdersFromSchema = catchAsync(async (req, res) => {
  const { page = 1, per_page = 20, search, from, to } = req.query;

  // Sync all active (non-delivered, non-RTO) orders into InTransitOrder collection
  const activeOrders = await Order.find({
    status: { $not: /^(delivered|rto)/i }
  }).select('order_id shiprocket_order_id shiprocket_shipment_id billing_customer_name billing_phone billing_city billing_state billing_pincode awb_code courier_name payment_method sub_total order_items status lead_id status_updated_at createdAt').lean();

  for (const o of activeOrders) {
    await InTransitOrder.findOneAndUpdate(
      { order_id: o.order_id },
      { $set: {
        order_id: o.order_id,
        shiprocket_order_id: o.shiprocket_order_id,
        shiprocket_shipment_id: o.shiprocket_shipment_id,
        billing_customer_name: o.billing_customer_name || '',
        billing_phone: o.billing_phone || '',
        billing_city: o.billing_city || '',
        billing_state: o.billing_state || '',
        billing_pincode: o.billing_pincode || '',
        awb_code: o.awb_code || '',
        courier_name: o.courier_name || '',
        payment_method: o.payment_method || '',
        sub_total: o.sub_total || 0,
        order_items: o.order_items || [],
        status: o.status,
        lead_id: o.lead_id || null,
        status_updated_at: o.status_updated_at || o.createdAt,
        order_date: o.createdAt,
      }},
      { upsert: true }
    ).catch(() => {});
  }

  // Remove orders that are now delivered or RTO (status changed)
  await InTransitOrder.deleteMany({ status: { $regex: /^(delivered|rto)/i } }).catch(() => {});

  const skip = (Number(page) - 1) * Number(per_page);
  const match = {};
  if (search) match.$or = [
    { billing_customer_name: { $regex: search, $options: 'i' } },
    { billing_phone: { $regex: search, $options: 'i' } },
    { order_id: { $regex: search, $options: 'i' } },
    { awb_code: { $regex: search, $options: 'i' } },
  ];
  if (from || to) {
    match.order_date = {};
    if (from) match.order_date.$gte = new Date(from + 'T00:00:00.000+05:30');
    if (to) match.order_date.$lte = new Date(to + 'T23:59:59.999+05:30');
  }

  const [data, total] = await Promise.all([
    InTransitOrder.find(match).sort({ status_updated_at: -1 }).skip(skip).limit(Number(per_page)).lean(),
    InTransitOrder.countDocuments(match),
  ]);

  res.json(new ApiResponse(200, { data, total }, 'In-transit orders fetched from schema'));
});

export const getDeliveredOrdersFromSchema = catchAsync(async (req, res) => {
  const { page = 1, per_page = 20, search, from, to } = req.query;

  // Auto-sync delivered orders from Order collection
  const newDelivered = await Order.find({ status: /^delivered$/i })
    .select('order_id shiprocket_order_id billing_customer_name billing_phone billing_email billing_address billing_city billing_state billing_pincode awb_code courier_name payment_method sub_total order_items status lead_id delivered_at createdAt')
    .lean();
  for (const o of newDelivered) {
    await DeliveredOrder.findOneAndUpdate(
      { order_id: o.order_id },
      { $set: {
        order_id: o.order_id,
        shiprocket_order_id: o.shiprocket_order_id,
        billing_customer_name: o.billing_customer_name || '',
        billing_phone: o.billing_phone || '',
        billing_email: o.billing_email || '',
        billing_address: o.billing_address || '',
        billing_city: o.billing_city || '',
        billing_state: o.billing_state || '',
        billing_pincode: o.billing_pincode || '',
        awb_code: o.awb_code || '',
        courier_name: o.courier_name || '',
        payment_method: o.payment_method || '',
        sub_total: o.sub_total || 0,
        order_items: o.order_items || [],
        status: o.status,
        lead_id: o.lead_id || null,
        delivered_at: o.delivered_at || o.createdAt,
        order_date: o.createdAt,
      }},
      { upsert: true }
    ).catch(() => {});
  }

  const skip = (Number(page) - 1) * Number(per_page);
  const match = {};
  if (search) match.$or = [
    { billing_customer_name: { $regex: search, $options: 'i' } },
    { billing_phone: { $regex: search, $options: 'i' } },
    { order_id: { $regex: search, $options: 'i' } },
    { awb_code: { $regex: search, $options: 'i' } },
  ];
  if (from || to) {
    match.delivered_at = {};
    if (from) match.delivered_at.$gte = new Date(from + 'T00:00:00.000+05:30');
    if (to) match.delivered_at.$lte = new Date(to + 'T23:59:59.999+05:30');
  }

  const [data, total] = await Promise.all([
    DeliveredOrder.find(match).sort({ delivered_at: -1 }).skip(skip).limit(Number(per_page)).lean(),
    DeliveredOrder.countDocuments(match),
  ]);

  res.json(new ApiResponse(200, { data, total }, 'Delivered orders fetched from schema'));
});

export const getDeliveredOrders = catchAsync(async (req, res) => {
  const { search, page = 1, per_page = 1000, delivered_from, delivered_to } = req.query;
  const statusMatch = { status: { $in: ['DELIVERED', 'RTO_DELIVERED', 'Delivered', 'RTO Delivered', 'delivered', 'rto_delivered'] } };
  if (delivered_from || delivered_to) {
    statusMatch.delivered_at = {};
    if (delivered_from) statusMatch.delivered_at.$gte = new Date(delivered_from);
    if (delivered_to) statusMatch.delivered_at.$lte = new Date(delivered_to + 'T23:59:59');
  }
  const match = search ? {
    ...statusMatch,
    $or: [{ billing_customer_name: { $regex: search, $options: 'i' } }, { billing_phone: { $regex: search, $options: 'i' } }, { order_id: { $regex: search, $options: 'i' } }, { awb_code: { $regex: search, $options: 'i' } }],
  } : statusMatch;
  const skip = (Number(page) - 1) * Number(per_page);
  const [orders, total] = await Promise.all([
    Order.find(match).sort({ createdAt: -1 }).skip(skip).limit(Number(per_page)).populate('lead_id', 'phone email').lean(),
    Order.countDocuments(match),
  ]);

  const allLeads = await Lead.find({ isDeleted: { $ne: true } }).select('name phone email address').lean();
  const byName = {}, byFirst = {}, byPincode = {}, pinCount = {};
  for (const l of allLeads) {
    if (!l.phone) continue;
    const full = (l.name || '').toLowerCase().trim();
    byName[full] = l;
    byFirst[full.split(/\s+/)[0]] = l;
    const pm = (l.address || '').match(/\b(\d{6})\b/);
    if (pm) { pinCount[pm[1]] = (pinCount[pm[1]] || 0) + 1; byPincode[pm[1]] = l; }
  }
  for (const p of Object.keys(pinCount)) { if (pinCount[p] > 1) delete byPincode[p]; }

  const getPhone = (name, pincode, masked) => {
    if (masked && !/^x+$/i.test(masked) && masked.length >= 10) return masked;
    const full = (name || '').toLowerCase().trim();
    const pin = String(pincode || '').trim();
    const lead = byName[full] || byFirst[full.split(/\s+/)[0]] || (pin && byPincode[pin]);
    return lead?.phone || masked;
  };

  const enriched = orders.map(o => {
    if (o.lead_id?.phone) return { ...o, billing_phone: o.lead_id.phone };
    const phone = getPhone(o.billing_customer_name, o.billing_pincode, o.billing_phone);
    return { ...o, billing_phone: phone };
  });
  res.json(new ApiResponse(200, { data: enriched, total, page: Number(page), per_page: Number(per_page) }, 'Delivered orders fetched'));
});

const setAutoFollowUps = async (orderId, deliveredAt) => {
  const settings = getFollowupSettings();
  const total = Number(settings.total_followups) || DEFAULT_FOLLOWUP_TOTAL;
  const gap = Number(settings.followup_gap_days) || DEFAULT_FOLLOWUP_GAP_DAYS;
  const base = new Date(deliveredAt);
  const ops = Array.from({ length: total }, (_, i) => {
    const scheduled_date = new Date(base);
    scheduled_date.setDate(scheduled_date.getDate() + (i + 1) * gap);
    const next_followup_date = i + 1 < total ? new Date(base) : null;
    if (next_followup_date) next_followup_date.setDate(next_followup_date.getDate() + (i + 2) * gap);
    return {
      updateOne: {
        filter: { order_id: orderId, followup_number: i + 1 },
        update: { $setOnInsert: { order_id: orderId, followup_number: i + 1, scheduled_date, next_followup_date, completed: false, status: 'scheduled' } },
        upsert: true,
      },
    };
  });
  await Followup.bulkWrite(ops);
  await Order.findByIdAndUpdate(orderId, { auto_followups_set: true });
};

export const completeFollowUp = catchAsync(async (req, res) => {
  const { id } = req.params;
  const settings = getFollowupSettings();
  const total = Number(settings.total_followups) || DEFAULT_FOLLOWUP_TOTAL;
  const gap = Number(settings.followup_gap_days) || DEFAULT_FOLLOWUP_GAP_DAYS;
  const count = await Followup.countDocuments({ order_id: id });
  if (count === 0) {
    const order = await Order.findById(id).select('delivered_at createdAt').lean();
    await setAutoFollowUps(id, order?.delivered_at || order?.createdAt || new Date());
  }
  const current = await Followup.findOne({ order_id: id, completed: false }).sort({ followup_number: 1 });
  if (!current) {
    await Order.findByIdAndUpdate(id, { followup_done: true });
    return res.json(new ApiResponse(200, { completedCount: total, next_follow_up: null }, 'All follow-ups done'));
  }
  current.completed = true;
  current.status = 'completed';
  current.staff = req.user?._id;
  current.followup_date = new Date();
  if (current.followup_number >= total) {
     await Order.findByIdAndUpdate(id, { followup_done: true });
  }
  current.completed_at = new Date();
  if (req.body?.note) {
    current.note = req.body.note;
    current.notes = req.body.note;
  }
  await current.save();

  await logOrderActivity({
    orderId: id,
    actor: req.user?._id,
    type: 'followup_completed',
    title: `${current.followup_number}${current.followup_number === 1 ? 'st' : current.followup_number === 2 ? 'nd' : current.followup_number === 3 ? 'rd' : 'th'} Follow-up Completed`,
    description: req.body?.note || '',
    metadata: { followup_number: current.followup_number },
  });

  // Shift remaining followups based on manual completion date and admin gap.
  const remaining = await Followup.find({ order_id: id, completed: false }).sort({ followup_number: 1 });
  let nextDate = null;
  if (remaining.length > 0) {
    let base = new Date();
    for (const fu of remaining) {
      base.setDate(base.getDate() + gap);
      fu.scheduled_date = new Date(base);
      fu.next_followup_date = null;
      await fu.save();
    }
    nextDate = remaining[0].scheduled_date;
    for (let i = 0; i < remaining.length - 1; i += 1) {
      remaining[i].next_followup_date = remaining[i + 1].scheduled_date;
      await remaining[i].save();
    }
  }

  await Order.findByIdAndUpdate(id, { next_follow_up: nextDate });
  res.json(new ApiResponse(200, { completedCount: current.followup_number, next_follow_up: nextDate, total_followups: total, followup_gap_days: gap }, 'Follow-up completed'));
});

export const updateFollowupRelief = catchAsync(async (req, res) => {
  const { id } = req.params;
  const { followup_number, relief_percentage } = req.body;
  if (!followup_number || relief_percentage === undefined) return res.status(400).json(new ApiResponse(400, null, 'followup_number and relief_percentage required'));
  const fu = await Followup.findOneAndUpdate(
    { order_id: id, followup_number: Number(followup_number) },
    { $set: { relief_percentage: Number(relief_percentage) } },
    { new: true }
  );
  if (!fu) return res.status(404).json(new ApiResponse(404, null, 'Followup not found'));
  res.json(new ApiResponse(200, fu, 'Relief percentage updated'));
});

export const getOrderActivity = catchAsync(async (req, res) => {
  const order = await Order.findById(req.params.id)
    .select('comments notes order_id billing_customer_name status createdAt')
    .populate('comments.createdBy', 'name role')
    .lean();
  if (!order) return res.status(404).json(new ApiResponse(404, null, 'Order not found'));
  const activity = (order.comments || []).map(c => ({
    _id: c._id,
    type: c.type || 'general',
    title: c.type === 'followup' ? 'Follow-up Note' : 'Note Added',
    description: c.text || '',
    actor: c.createdBy,
    createdAt: c.createdAt,
  }));
  res.json(new ApiResponse(200, activity, 'Activity fetched'));
});

export const updateOrderContact = catchAsync(async (req, res) => {
  const { id } = req.params;
  const allowed = ['billing_phone', 'billing_city', 'billing_state', 'billing_pincode', 'billing_address'];
  const update = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) update[key] = String(req.body[key]).trim();
  }
  if (!Object.keys(update).length) return res.status(400).json(new ApiResponse(400, null, 'No valid fields'));
  const order = await Order.findByIdAndUpdate(id, { $set: update }, { new: true })
    .select(allowed.join(' ') + ' lead_id').lean();

  // Also update Lead so phone persists after Shiprocket sync
  if (order?.lead_id) {
    const leadUpdate = {};
    if (update.billing_phone) leadUpdate.phone = update.billing_phone;
    if (update.billing_city) leadUpdate.cityVillage = update.billing_city;
    if (update.billing_state) leadUpdate.state = update.billing_state;
    if (update.billing_pincode) leadUpdate.pincode = update.billing_pincode;
    if (update.billing_address) leadUpdate.address = update.billing_address;
    if (Object.keys(leadUpdate).length) await Lead.findByIdAndUpdate(order.lead_id, { $set: leadUpdate });
  }

  // If no lead linked, try to find by name/pincode and link it
  if (!order?.lead_id && update.billing_phone) {
    const existingOrder = await Order.findById(id).select('billing_customer_name billing_pincode').lean();
    if (existingOrder) {
      const lead = await Lead.findOne({
        $or: [
          { phone: update.billing_phone },
          { name: { $regex: new RegExp(existingOrder.billing_customer_name, 'i') } },
        ],
        isDeleted: { $ne: true },
      }).select('_id').lean();
      if (lead) await Order.findByIdAndUpdate(id, { lead_id: lead._id });
    }
  }

  res.json(new ApiResponse(200, order, 'Contact updated'));
});

export const saveOrderNote = catchAsync(async (req, res) => {
  if (Object.prototype.hasOwnProperty.call(req.body, 'notes')) {
    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { notes: String(req.body.notes || '') },
      { new: true }
    ).select('notes').lean();

    return res.json(new ApiResponse(200, order, 'Note saved'));
  }

  const { text, type = 'general', section = '' } = req.body;
  if (!text?.trim()) return res.status(400).json(new ApiResponse(400, null, 'Comment text required'));
  const order = await Order.findByIdAndUpdate(
    req.params.id,
    { $push: { comments: { text: text.trim(), type, section: section.trim(), createdBy: req.user._id, createdAt: new Date() } } },
    { new: true }
  ).populate('comments.createdBy', 'name role').select('comments').lean();
  await logOrderActivity({
    orderId: req.params.id,
    actor: req.user?._id,
    type: 'note_added',
    title: type === 'followup' ? 'Follow-up Note Added' : 'Order Note Added',
    description: text.trim(),
  });
  res.json(new ApiResponse(200, order?.comments || [], 'Comment added'));
});

export const addFollowUp = catchAsync(async (req, res) => {
  const { id } = req.params;
  const { note, next_follow_up, status = 'scheduled' } = req.body;
  const existing = await Followup.countDocuments({ order_id: id });
  await Followup.create({
    order_id: id,
    followup_number: existing + 1,
    scheduled_date: next_follow_up ? new Date(next_follow_up) : new Date(),
    followup_date: status === 'completed' ? new Date() : undefined,
    staff: status === 'completed' ? req.user?._id : undefined,
    status,
    note: note || '',
    notes: note || '',
    completed: status === 'completed',
    completed_at: status === 'completed' ? new Date() : undefined,
  });
  const order = await Order.findByIdAndUpdate(id, { ...(next_follow_up ? { next_follow_up: new Date(next_follow_up) } : {}) }, { new: true }).select('follow_ups next_follow_up').lean();
  res.json(new ApiResponse(200, order, 'Follow up added'));
});

export const setNextFollowUp = catchAsync(async (req, res) => {
  const order = await Order.findByIdAndUpdate(req.params.id, { next_follow_up: req.body.next_follow_up ? new Date(req.body.next_follow_up) : null }, { new: true }).select('follow_ups next_follow_up').lean();
  res.json(new ApiResponse(200, order, 'Next follow up set'));
});

export const getOrdersWithFollowUps = catchAsync(async (req, res) => {
  const settings = getFollowupSettings();
  const totalFollowups = Number(settings.total_followups) || DEFAULT_FOLLOWUP_TOTAL;

  // Backfill: flag orders where all configured followups are done but followup_done not set
  const unflagged = await Order.find({
    status: { $in: ['DELIVERED', 'Delivered', 'delivered'] },
    auto_followups_set: true,
    followup_done: { $ne: true },
  }).select('_id').lean();
  if (unflagged.length > 0) {
    const fuCounts = await Followup.aggregate([
      { $match: { order_id: { $in: unflagged.map(o => o._id) } } },
      { $group: { _id: '$order_id', total: { $sum: 1 }, incomplete: { $sum: { $cond: ['$completed', 0, 1] } } } },
      { $match: { total: { $gte: totalFollowups }, incomplete: 0 } },
    ]);
    if (fuCounts.length > 0) {
      await Order.updateMany({ _id: { $in: fuCounts.map(f => f._id) } }, { $set: { followup_done: true } });
      console.log(`[FollowUp] Backfilled followup_done for ${fuCounts.length} orders.`);
    }
  }

  // --- Department Filtering Logic ---
  let leadQuery = { isDeleted: { $ne: true } };
  if (['sales', 'logistics'].includes(req.user.role) && req.userDepartments && req.userDepartments.length > 0) {
    leadQuery.department = { $in: req.userDepartments };
  } else if (req.query.department) {
    leadQuery.department = req.query.department;
  }
  let validLeadIds = null;
  if (leadQuery.department) {
    const Lead = (await import('../lead/lead.model.js')).default;
    const leads = await Lead.find(leadQuery).select('_id').lean();
    validLeadIds = leads.map(l => l._id);
  }
  // ----------------------------------

  const query = { 
    status: { $in: ['DELIVERED', 'Delivered', 'delivered'] },
    followup_done: { $ne: true },
    sent_to_verification: { $ne: true },
  };
  if (validLeadIds !== null) {
    query.lead_id = { $in: validLeadIds };
  }

  const delivered = await Order.find(query)
    .populate({
      path: 'lead_id',
      select: 'createdBy assignedTo department status',
      populate: [
        { path: 'createdBy', select: 'name role' },
        { path: 'assignedTo', select: 'name role' }
      ]
    })
    .populate('verified_by', 'name role')
    .populate('created_by', 'name role')
    .sort({ delivered_at: -1, createdAt: -1 }).lean();
  const needsSetting = delivered.filter(o => !o.auto_followups_set);
  if (needsSetting.length) {
    await Promise.all(needsSetting.map(o => setAutoFollowUps(o._id, o.delivered_at || o.createdAt || new Date())));
  }
  const allFollowups = await Followup.find({ order_id: { $in: delivered.map(o => o._id) } })
    .populate('staff', 'name role')
    .sort({ followup_number: 1 })
    .lean();
  const fuMap = {};
  for (const fu of allFollowups) {
    const key = String(fu.order_id);
    if (!fuMap[key]) fuMap[key] = [];
    fuMap[key].push(fu);
  }
  const allLeads = await Lead.find({ isDeleted: { $ne: true } })
    .select('name phone address assignedTo createdBy')
    .populate('assignedTo', 'name role')
    .populate('createdBy', 'name role')
    .lean();
  const byName = {}, byPin = {}, pinCount = {};
  for (const l of allLeads) {
    if (!l.phone) continue;
    const full = (l.name || '').toLowerCase().trim();
    byName[full] = l;
    const pm = (l.address || '').match(/\b(\d{6})\b/);
    if (pm) { pinCount[pm[1]] = (pinCount[pm[1]] || 0) + 1; byPin[pm[1]] = l; }
  }
  for (const p of Object.keys(pinCount)) { if (pinCount[p] > 1) delete byPin[p]; }

  const enriched = delivered.map(o => {
    const followups = fuMap[String(o._id)] || [];
    if (o.billing_phone && !/^x+$/i.test(o.billing_phone) && String(o.billing_phone).replace(/\D/g, '').length >= 10) return { ...o, followups };
    const full = (o.billing_customer_name || '').toLowerCase().trim();
    let lead = byName[full];
    if (!lead) {
      const words = full.split(/\s+/);
      lead = Object.entries(byName).find(([k]) => words.every(w => k.includes(w)))?.[1];
    }
    if (!lead && o.billing_pincode) lead = byPin[String(o.billing_pincode).trim()];
    return { ...o, lead_id: o.lead_id || lead, billing_phone: lead?.phone || o.billing_phone, followups };
  });

  const leadIds = enriched.map(o => o.lead_id?._id || o.lead_id).filter(Boolean);
  const allOrdersForLeads = await Order.find({ lead_id: { $in: leadIds } })
    .select('_id lead_id createdAt')
    .sort({ createdAt: 1 })
    .lean();

  const seqMap = {};
  const leadOrderCount = {};
  for (const oc of allOrdersForLeads) {
    const lId = String(oc.lead_id);
    if (!leadOrderCount[lId]) leadOrderCount[lId] = 0;
    leadOrderCount[lId]++;
    seqMap[String(oc._id)] = leadOrderCount[lId];
  }

  enriched.forEach(o => {
    o.kit_number = seqMap[String(o._id)] || 1;
  });
  res.json(new ApiResponse(200, enriched, 'Orders with follow-ups fetched'));
});

export const getCompletedFollowUps = catchAsync(async (req, res) => {
  const { search, page = 1, per_page = 20 } = req.query;
  // --- Department Filtering Logic ---
  let leadQuery = { isDeleted: { $ne: true } };
  if (['sales', 'logistics'].includes(req.user.role) && req.userDepartments && req.userDepartments.length > 0) {
    leadQuery.department = { $in: req.userDepartments };
  } else if (req.query.department) {
    leadQuery.department = req.query.department;
  }
  let validLeadIds = null;
  if (leadQuery.department) {
    const Lead = (await import('../lead/lead.model.js')).default;
    const leads = await Lead.find(leadQuery).select('_id').lean();
    validLeadIds = leads.map(l => l._id);
  }
  // ----------------------------------

  const match = {
    status: { $in: ['DELIVERED', 'Delivered', 'delivered'] },
    followup_done: true,
  };
  if (validLeadIds !== null) {
    match.lead_id = { $in: validLeadIds };
  }
  if (search) {
    match.$or = [
      { billing_customer_name: { $regex: search, $options: 'i' } },
      { billing_phone: { $regex: search, $options: 'i' } },
      { order_id: { $regex: search, $options: 'i' } },
      { awb_code: { $regex: search, $options: 'i' } },
    ];
  }

  const skip = (Number(page) - 1) * Number(per_page);
  const [orders, total] = await Promise.all([
    Order.find(match)
      .populate({
        path: 'lead_id',
        select: 'createdBy assignedTo department status',
        populate: [
          { path: 'createdBy', select: 'name role' },
          { path: 'assignedTo', select: 'name role' },
        ],
      })
      .populate('verified_by', 'name role')
      .populate('created_by', 'name role')
      .sort({ delivered_at: -1, updatedAt: -1 })
      .skip(skip)
      .limit(Number(per_page))
      .lean(),
    Order.countDocuments(match),
  ]);

  const allFollowups = await Followup.find({ order_id: { $in: orders.map(o => o._id) } })
    .populate('staff', 'name role')
    .sort({ followup_number: 1 })
    .lean();
  const fuMap = {};
  for (const fu of allFollowups) {
    const key = String(fu.order_id);
    if (!fuMap[key]) fuMap[key] = [];
    fuMap[key].push(fu);
  }

  const allLeads = await Lead.find({ isDeleted: { $ne: true } })
    .select('name phone address assignedTo createdBy')
    .populate('assignedTo', 'name role')
    .populate('createdBy', 'name role')
    .lean();
  const byName = {}, byPin = {}, pinCount = {};
  for (const l of allLeads) {
    if (!l.phone) continue;
    const full = (l.name || '').toLowerCase().trim();
    byName[full] = l;
    const pm = (l.address || '').match(/\b(\d{6})\b/);
    if (pm) { pinCount[pm[1]] = (pinCount[pm[1]] || 0) + 1; byPin[pm[1]] = l; }
  }
  for (const p of Object.keys(pinCount)) { if (pinCount[p] > 1) delete byPin[p]; }

  const enriched = orders.map(o => {
    const followups = fuMap[String(o._id)] || [];
    if (o.billing_phone && !/^x+$/i.test(o.billing_phone) && String(o.billing_phone).replace(/\D/g, '').length >= 10) return { ...o, followups };
    const full = (o.billing_customer_name || '').toLowerCase().trim();
    let lead = byName[full];
    if (!lead) {
      const words = full.split(/\s+/);
      lead = Object.entries(byName).find(([k]) => words.every(w => k.includes(w)))?.[1];
    }
    if (!lead && o.billing_pincode) lead = byPin[String(o.billing_pincode).trim()];
    return { ...o, lead_id: o.lead_id || lead, billing_phone: lead?.phone || o.billing_phone, followups };
  });

  const leadIds = enriched.map(o => o.lead_id?._id || o.lead_id).filter(Boolean);
  const allOrdersForLeads = await Order.find({ lead_id: { $in: leadIds } })
    .select('_id lead_id createdAt')
    .sort({ createdAt: 1 })
    .lean();

  const seqMap = {};
  const leadOrderCount = {};
  for (const oc of allOrdersForLeads) {
    const lId = String(oc.lead_id);
    if (!leadOrderCount[lId]) leadOrderCount[lId] = 0;
    leadOrderCount[lId]++;
    seqMap[String(oc._id)] = leadOrderCount[lId];
  }

  enriched.forEach(o => {
    o.kit_number = seqMap[String(o._id)] || 1;
  });

  res.json(new ApiResponse(200, { data: enriched, total, page: Number(page), per_page: Number(per_page) }, 'Completed follow-ups fetched'));
});

export const getDeliveredOrdersLive = catchAsync(async (req, res) => {
  let pg = 1, collected = [];
  for (;;) {
    const data = await sr.getOrders({ per_page: 100, page: pg });
    const list = data?.data || [];
    if (!list.length) break;
    collected = [...collected, ...list.filter(o => o.status?.toLowerCase() === 'delivered')];
    if (pg >= (data?.meta?.pagination?.total_pages || 1)) break;
    pg++;
  }
  const allLeads = await Lead.find({ isDeleted: { $ne: true } }).select('name phone email').lean();
  const phoneMap = {};
  for (const l of allLeads) {
    if (!l.phone) continue;
    phoneMap[l.name.toLowerCase().trim()] = { phone: l.phone, email: l.email };
    const first = l.name.toLowerCase().trim().split(/\s+/)[0];
    if (first) phoneMap[first] = { phone: l.phone, email: l.email };
  }
  const enriched = collected.map(o => {
    const fullName = (o.customer_name || '').toLowerCase().trim();
    const match = phoneMap[fullName] || phoneMap[fullName.split(/\s+/)[0]];
    return { ...o, real_phone: match?.phone || null, real_email: match?.email || null };
  });
  res.json(new ApiResponse(200, { data: enriched, total: enriched.length }, 'Live delivered orders'));
});


const INDIA_TIME_OFFSET = '+05:30';
const startOfIndiaDate = (date) => new Date(`${date}T00:00:00.000${INDIA_TIME_OFFSET}`);
const endOfIndiaDate = (date) => new Date(`${date}T23:59:59.999${INDIA_TIME_OFFSET}`);

const buildOrderDateMatch = ({ filterType, year, month, from, to }, field = 'createdAt') => {
  const dateMatch = {};
  if (filterType === 'yearly' && year) dateMatch[field] = { $gte: startOfIndiaDate(`${year}-01-01`), $lt: startOfIndiaDate(`${Number(year) + 1}-01-01`) };
  else if (filterType === 'monthly' && year && month) {
    const m = Number(month);
    dateMatch[field] = { $gte: startOfIndiaDate(`${year}-${String(m).padStart(2,'0')}-01`), $lt: startOfIndiaDate(m === 12 ? `${Number(year)+1}-01-01` : `${year}-${String(m+1).padStart(2,'0')}-01`) };
  } else if (filterType === 'range' && from && to) dateMatch[field] = { $gte: startOfIndiaDate(from), $lte: endOfIndiaDate(to) };
  return dateMatch;
};

const buildStatusDateMatch = (params) => {
  // Use status_updated_at for non-delivered statuses (reflects current state timing)
  const byUpdated = buildOrderDateMatch(params, 'status_updated_at');
  const byCreated = buildOrderDateMatch(params, 'createdAt');
  if (!Object.keys(byUpdated).length) return {};
  return { $or: [byUpdated, { status_updated_at: null, ...byCreated }] };
};

// Build a date match for delivered orders that falls back to createdAt when delivered_at is null
const buildDeliveredDateMatch = ({ filterType, year, month, from, to }) => {
  const byDeliveredAt = buildOrderDateMatch({ filterType, year, month, from, to }, 'delivered_at');
  const byCreatedAt = buildOrderDateMatch({ filterType, year, month, from, to }, 'createdAt');
  if (!Object.keys(byDeliveredAt).length) return {}; // ALL TIME — no date filter
  return {
    $or: [
      byDeliveredAt,
      { delivered_at: null, ...byCreatedAt },
    ],
  };
};

export const getDeliveredStats = catchAsync(async (req, res) => {
  const { filterType, year, month, from, to } = req.query;
  const deliveredDateMatch = buildDeliveredDateMatch({ filterType, year, month, from, to });
  const statusDateMatch = buildStatusDateMatch({ filterType, year, month, from, to });
  const [result, statusBreakdown] = await Promise.all([
    Order.aggregate([
      { $match: { status: /^delivered$/i, ...deliveredDateMatch } },
      { $group: { _id: null, count: { $sum: 1 }, revenue: { $sum: { $convert: { input: '$sub_total', to: 'double', onError: 0, onNull: 0 } } } } },
    ]),
    Order.aggregate([{ $match: { status: { $not: /^delivered$/i }, ...statusDateMatch } }, { $group: { _id: '$status', count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
  ]);
  const { count = 0, revenue = 0 } = result[0] || {};
  // Merge IN_TRANSIT variants
  const merged = [];
  let inTransitCount = 0;
  for (const item of statusBreakdown) {
    if (/^in.transit/i.test(item._id)) { inTransitCount += item.count; }
    else merged.push(item);
  }
  if (inTransitCount > 0) merged.unshift({ _id: 'IN_TRANSIT', count: inTransitCount });
  merged.unshift({ _id: 'DELIVERED', count });
  res.json(new ApiResponse(200, { count, revenue, statusBreakdown: merged }, 'Delivered stats'));
});

export const getStatusOrders = catchAsync(async (req, res) => {
  const { status, filterType, year, month, from, to, limit = 50 } = req.query;
  if (!status) return res.status(400).json(new ApiResponse(400, null, 'Status is required'));
  
  const isDelivered = /^delivered$/i.test(status);
  const isUndelivered = /^undelivered$/i.test(status);
  const dateMatch = isDelivered
    ? buildDeliveredDateMatch({ filterType, year, month, from, to })
    : buildStatusDateMatch({ filterType, year, month, from, to });

  // Match underscore, space, and hyphen variants (e.g. UNDELIVERED-2ND_ATTEMPT, UNDELIVERED-2ND ATTEMPT)
  const statusVariant = status.replace(/[-_]/g, '[-_ ]');
  const statusQuery = isUndelivered
    ? { status: { $regex: /^undelivered/i } }
    : { status: new RegExp(`^${statusVariant}$`, 'i') };

  const orders = await Order.find({ ...statusQuery, ...dateMatch })
    .populate({ path: 'lead_id', select: 'phone email assignedTo', populate: { path: 'assignedTo', select: 'name role' } })
    .populate('comments.createdBy', 'name role')
    .sort(/^delivered$/i.test(status) ? { delivered_at: -1, createdAt: -1 } : { createdAt: -1 })
    .limit(Math.min(Number(limit) || 50, 200)).lean();

  // Optimized enrichment: instead of fetching all leads, only fetch what's needed for these specific orders
  const unlinked = orders.filter(o => !o.lead_id || !o.lead_id.assignedTo);
  
  if (unlinked.length > 0) {
    const phones = unlinked.map(o => String(o.billing_phone || '').replace(/\D/g, '')).filter(p => p.length >= 10 && !/^x+$/i.test(p));
    const names = unlinked.map(o => (o.billing_customer_name || '').toLowerCase().trim()).filter(Boolean);
    const pins = unlinked.map(o => String(o.billing_pincode || '').trim()).filter(p => p.length === 6);

    const leads = await Lead.find({
      isDeleted: { $ne: true },
      $or: [
        { phone: { $in: phones } },
        { name: { $in: names } },
        { pincode: { $in: pins } }
      ]
    }).select('name phone email address pincode assignedTo').populate('assignedTo', 'name role').lean();

    const byPhone = {};
    const byName = {};
    const byPin = {};
    const pinCount = {};

    leads.forEach(l => {
      if (l.phone) byPhone[String(l.phone).replace(/\D/g, '')] = l;
      if (l.name) byName[l.name.toLowerCase().trim()] = l;
      if (l.pincode) {
        pinCount[l.pincode] = (pinCount[l.pincode] || 0) + 1;
        byPin[l.pincode] = l;
      }
    });
    // Remove ambiguous pincode matches
    Object.keys(pinCount).forEach(p => { if (pinCount[p] > 1) delete byPin[p]; });

    orders.forEach(o => {
      const staff = o.lead_id?.assignedTo;
      if (staff) {
        o.staff_name = staff.name || '';
        o.staff_role = staff.role || '';
        return;
      }

      const cleanPhone = String(o.billing_phone || '').replace(/\D/g, '');
      const lead = (cleanPhone.length >= 10 && byPhone[cleanPhone]) || 
                   byName[(o.billing_customer_name || '').toLowerCase().trim()] || 
                   byPin[String(o.billing_pincode || '').trim()];

      if (lead) {
        o.staff_name = lead.assignedTo?.name || '';
        o.staff_role = lead.assignedTo?.role || '';
        if (!o.billing_phone || /^x+$/i.test(o.billing_phone)) o.billing_phone = lead.phone;
      } else {
        o.staff_name = '';
        o.staff_role = '';
      }
    });
  } else {
    orders.forEach(o => {
      o.staff_name = o.lead_id?.assignedTo?.name || '';
      o.staff_role = o.lead_id?.assignedTo?.role || '';
    });
  }

  res.json(new ApiResponse(200, { data: orders, total: orders.length }, 'Status orders fetched'));
});

export const getLocalOrderLookup = catchAsync(async (req, res) => {
  const { awb, order_id, channel_order_id, shipment_id, _id } = req.query;
  const query = [];
  if (_id) query.push({ _id: String(_id) });
  if (awb) query.push({ awb_code: String(awb) });
  if (order_id) { query.push({ order_id: String(order_id) }); if (!Number.isNaN(Number(order_id))) query.push({ shiprocket_order_id: Number(order_id) }); }
  if (channel_order_id) query.push({ order_id: String(channel_order_id) });
  if (shipment_id && !Number.isNaN(Number(shipment_id))) query.push({ shiprocket_shipment_id: Number(shipment_id) });
  if (!query.length) return res.status(400).json(new ApiResponse(400, null, 'Param required'));
  const order = await Order.findOne({ $or: query }).populate('lead_id', 'phone email').lean();
  if (!order) return res.json(new ApiResponse(200, null, 'Not found'));
  const allLeads = await Lead.find({ isDeleted: { $ne: true } }).select('name phone address').lean();
  const byName = {}, byPincode = {}, pinCount = {};
  for (const l of allLeads) {
    if (!l.phone) continue;
    byName[(l.name || '').toLowerCase().trim()] = l;
    const pm = (l.address || '').match(/\b(\d{6})\b/);
    if (pm) { pinCount[pm[1]] = (pinCount[pm[1]] || 0) + 1; byPincode[pm[1]] = l; }
  }
  for (const p of Object.keys(pinCount)) { if (pinCount[p] > 1) delete byPincode[p]; }
  let phone = order.lead_id?.phone || order.billing_phone;
  if (!order.lead_id?.phone && (/^x+$/i.test(phone) || String(phone).replace(/\D/g, '').length < 10)) {
    const full = (order.billing_customer_name || '').toLowerCase().trim();
    let lead = byName[full];
    if (!lead) { const words = full.split(/\s+/).filter(w => w.length > 2); if (words.length > 0) lead = Object.entries(byName).find(([k]) => words.every(w => k.includes(w)))?.[1]; }
    if (!lead && order.billing_pincode) lead = byPincode[String(order.billing_pincode).trim()];
    phone = lead?.phone || phone;
  }
  res.json(new ApiResponse(200, { ...order, billing_phone: phone }, 'Order fetched'));
});

export const backfillDeliveredAt = catchAsync(async (req, res) => {
  // Fix delivered_at — fetch and update individually to avoid pipeline syntax issues
  const nullDelivered = await Order.find({ status: /^delivered$/i, delivered_at: null }).select('_id createdAt').lean();
  await Promise.all(nullDelivered.map(o => Order.updateOne({ _id: o._id }, { $set: { delivered_at: o.createdAt } })));
  const r1 = { modifiedCount: nullDelivered.length };

  // Fix fragmented IN_TRANSIT variants → merge into IN_TRANSIT
  const r3 = await Order.updateMany(
    { status: { $regex: /^in.transit/i, $not: /^IN_TRANSIT$/ } },
    { $set: { status: 'IN_TRANSIT' } }
  );

  // Fix missing or count-like sub_total values by recalculating from raw money fields/order_items.
  const zeroOrders = await Order.find({ sub_total: { $in: [0, 1, null] }, 'order_items.0': { $exists: true } })
    .select('_id order_items raw_response').lean();
  let r2 = 0;
  await Promise.all(zeroOrders.map(async (o) => {
    const raw = o.raw_response || {};
    const itemsTotal = (o.order_items || []).reduce((sum, item) =>
      sum + (Number(item.selling_price) || 0) * (Number(item.units) || 1), 0);
    const total = getOrderAmount(raw, itemsTotal);
    if (total > 0) {
      await Order.updateOne({ _id: o._id }, { $set: { sub_total: total } });
      r2++;
    }
  }));

  // Backfill lead_id on unlinked orders by matching pincode then name
  const unlinked = await Order.find({ lead_id: null })
    .select('_id billing_customer_name billing_pincode billing_phone').lean();
  const allLeads = await Lead.find({ isDeleted: { $ne: true } }).select('name phone address pincode').lean();
  const byLeadName = {}, byLeadPin = {}, leadPinCount = {};
  for (const l of allLeads) {
    byLeadName[(l.name || '').toLowerCase().trim()] = l;
    const pin = l.pincode || (l.address || '').match(/\b(\d{6})\b/)?.[1];
    if (pin) { leadPinCount[pin] = (leadPinCount[pin] || 0) + 1; byLeadPin[pin] = l; }
  }
  for (const p of Object.keys(leadPinCount)) { if (leadPinCount[p] > 1) delete byLeadPin[p]; }
  let r4 = 0;
  await Promise.all(unlinked.map(async (o) => {
    const full = (o.billing_customer_name || '').toLowerCase().trim();
    const pin = String(o.billing_pincode || '').trim();
    let lead = byLeadName[full];
    if (!lead) {
      const words = full.split(/\s+/).filter(w => w.length > 2);
      if (words.length) lead = Object.entries(byLeadName).find(([k]) => words.every(w => k.includes(w)))?.[1];
    }
    if (!lead && pin) lead = byLeadPin[pin];
    if (lead) { await Order.updateOne({ _id: o._id }, { $set: { lead_id: lead._id, billing_phone: lead.phone } }); r4++; }
  }));

  res.json(new ApiResponse(200,
    { deliveredAtFixed: r1.modifiedCount, subTotalFixed: r2, inTransitMerged: r3.modifiedCount, leadsLinked: r4 },
    `Fixed: ${r1.modifiedCount} delivered_at, ${r2} sub_total, ${r3.modifiedCount} in_transit, ${r4} leads linked`));
});

// Debug: inspect raw Shiprocket order fields to find correct amount field
export const debugOrderFields = catchAsync(async (req, res) => {
  const sample = await Order.find({ status: /^delivered$/i })
    .select('sub_total order_items raw_response order_id').limit(5).lean();
  const result = sample.map(o => ({
    order_id: o.order_id,
    sub_total: o.sub_total,
    items_total: (o.order_items || []).reduce((s, i) => s + (Number(i.selling_price) || 0) * (Number(i.units) || 1), 0),
    raw_total: o.raw_response?.total,
    raw_sub_total: o.raw_response?.sub_total,
    raw_order_total: o.raw_response?.order_total,
    raw_price: o.raw_response?.price,
    raw_amount: o.raw_response?.amount,
  }));
  res.json(new ApiResponse(200, result, 'Debug info'));
});

export const getOrder = catchAsync(async (req, res) => { res.json(new ApiResponse(200, await sr.getOrder(req.params.id), 'Order fetched')); });
export const checkServiceability = catchAsync(async (req, res) => { res.json(new ApiResponse(200, await sr.checkServiceability(req.query), 'Serviceability fetched')); });
export const getCourierListWithCounts = catchAsync(async (req, res) => { res.json(new ApiResponse(200, await sr.getCourierListWithCounts(), 'Courier list fetched')); });
export const assignAWB = catchAsync(async (req, res) => {
  const { shipment_id, courier_id } = req.body;
  const data = await sr.assignAWB(shipment_id, courier_id);
  const awb = data?.awb_code || data?.response?.data?.awb_code;
  if (awb && shipment_id) {
    await Shipment.findOneAndUpdate({ shiprocket_shipment_id: Number(shipment_id) }, { awb_code: awb, courier_id: Number(courier_id), raw_response: data }, { upsert: true });
    await Order.findOneAndUpdate({ shiprocket_shipment_id: Number(shipment_id) }, { awb_code: awb, courier_id: Number(courier_id) });
  }
  res.json(new ApiResponse(200, data, 'AWB assigned'));
});
export const reassignCourier = catchAsync(async (req, res) => { res.json(new ApiResponse(200, await sr.reassignCourier(req.body), 'Courier reassigned')); });
export const getShipments = catchAsync(async (req, res) => { res.json(new ApiResponse(200, await sr.getShipmentsWithDetails(req.query), 'Shipments fetched')); });
export const getShipment = catchAsync(async (req, res) => { res.json(new ApiResponse(200, await sr.getShipment(req.params.id), 'Shipment fetched')); });
export const cancelShipment = catchAsync(async (req, res) => { res.json(new ApiResponse(200, await sr.cancelShipment(req.body.awbs), 'Shipment cancelled')); });
export const generateLabel = catchAsync(async (req, res) => {
  const sids = Array.isArray(req.body.shipment_id) ? req.body.shipment_id.map(Number).filter(Boolean) : [Number(req.body.shipment_id)].filter(Boolean);
  const data = await sr.generateLabel(sids.length === 1 ? sids[0] : sids);
  if (data?.label_url) await Shipment.updateMany({ shiprocket_shipment_id: { $in: sids } }, { label_url: data.label_url });
  res.json(new ApiResponse(200, data, 'Label generated'));
});
export const generateManifest = catchAsync(async (req, res) => {
  const sids = Array.isArray(req.body.shipment_id) ? req.body.shipment_id.map(Number).filter(Boolean) : [Number(req.body.shipment_id)].filter(Boolean);
  const data = await sr.generateManifest(sids.length === 1 ? sids[0] : sids);
  if (data?.manifest_url) await Shipment.updateMany({ shiprocket_shipment_id: { $in: sids } }, { manifest_url: data.manifest_url });
  res.json(new ApiResponse(200, data, 'Manifest generated'));
});
export const printManifest = catchAsync(async (req, res) => { res.json(new ApiResponse(200, await sr.printManifest(req.body.order_ids), 'Manifest print URL')); });
export const printInvoice = catchAsync(async (req, res) => { res.json(new ApiResponse(200, await sr.printInvoice(req.body.ids), 'Invoice print URL')); });
export const generatePickup = catchAsync(async (req, res) => {
  const { shipment_id } = req.body;
  const sid = Number(shipment_id);
  if (!sid) return res.status(400).json(new ApiResponse(400, null, 'shipment_id is required'));
  try {
    const data = await sr.generatePickup(sid);
    if (data?.pickup_scheduled_date) {
      await Shipment.findOneAndUpdate(
        { shiprocket_shipment_id: sid },
        { pickup_scheduled_date: data.pickup_scheduled_date, pickup_token_number: data.pickup_token_number },
        { upsert: true }
      );
    }
    res.json(new ApiResponse(200, data, 'Pickup generated'));
  } catch (err) {
    const msg = err.message || 'Pickup generation failed';
    res.status(200).json(new ApiResponse(500, { message: msg }, msg));
  }
});
export const cancelPickup = catchAsync(async (req, res) => { res.json(new ApiResponse(200, await sr.cancelPickup(req.body), 'Pickup cancelled')); });
export const getPickupLocations = catchAsync(async (req, res) => { res.json(new ApiResponse(200, await sr.getPickupLocations(), 'Pickup locations fetched')); });
export const trackByAWB = catchAsync(async (req, res) => {
  const data = await sr.trackByAWB(req.params.awb);
  await TrackingLog.create({ awb_code: req.params.awb, current_status: data?.tracking_data?.current_status, raw_response: data });
  res.json(new ApiResponse(200, data, 'Tracking info fetched'));
});
export const trackByShipment = catchAsync(async (req, res) => {
  const data = await sr.trackByShipment(req.params.id);
  await TrackingLog.create({ shipment_id: Number(req.params.id), current_status: data?.tracking_data?.current_status, raw_response: data });
  res.json(new ApiResponse(200, data, 'Tracking info fetched'));
});
export const createReturn = catchAsync(async (req, res) => {
  const data = await sr.createReturn(req.body);
  await Return.create({ shiprocket_order_id: data?.order_id, shiprocket_shipment_id: data?.shipment_id, order_id: String(req.body.order_id || ''), awb_code: data?.awb_code, return_reason: req.body.return_reason, raw_response: data });
  res.json(new ApiResponse(200, data, 'Return created'));
});
export const getReturns = catchAsync(async (req, res) => {
  const { page = 1, per_page = 20 } = req.query;

  // Sync RTO orders from Order collection into Return collection
  const rtoOrders = await Order.find({
    status: { $regex: /^rto/i }
  }).select('order_id shiprocket_order_id shiprocket_shipment_id billing_customer_name billing_phone awb_code courier_name sub_total payment_method status lead_id createdAt').lean();

  console.log('[returns] RTO orders found:', rtoOrders.length);

  for (const o of rtoOrders) {
    try {
      await Return.findOneAndUpdate(
        { order_id: o.order_id },
        { $set: {
          order_id: o.order_id,
          shiprocket_order_id: o.shiprocket_order_id,
          billing_customer_name: o.billing_customer_name || '',
          billing_phone: o.billing_phone || '',
          awb_code: o.awb_code || '',
          courier_name: o.courier_name || '',
          sub_total: o.sub_total || 0,
          payment_method: o.payment_method || '',
          status: o.status,
          lead_id: o.lead_id || null,
          return_date: o.createdAt,
        }},
        { upsert: true }
      );
    } catch (e) {
      console.log('[returns] upsert error:', o.order_id, e.message);
    }
  }

  const skip = (Number(page) - 1) * Number(per_page);
  const [data, total] = await Promise.all([
    Return.find()
      .populate({ path: 'lead_id', select: 'assignedTo', populate: { path: 'assignedTo', select: 'name role' } })
      .sort({ return_date: -1 })
      .skip(skip)
      .limit(Number(per_page))
      .lean(),
    Return.countDocuments(),
  ]);

  console.log('[returns] serving from DB:', total);
  const enriched = data.map(item => ({
    ...item,
    staff_name: item.lead_id?.assignedTo?.name || '',
    staff_role: item.lead_id?.assignedTo?.role || '',
  }));
  res.json(new ApiResponse(200, { data: enriched, total }, 'Returns fetched'));
});
export const getWalletBalance = catchAsync(async (req, res) => {
  try {
    const data = await sr.getWalletBalance();
    res.json(new ApiResponse(200, data, 'Wallet balance fetched'));
  } catch (err) {
    res.json(new ApiResponse(200, null, err.message || 'Wallet balance unavailable'));
  }
});
export const getWalletTransactions = catchAsync(async (req, res) => {
  const { page = 1, per_page = 20, from, to, status } = req.query;

  // Sync new orders into WalletTransaction collection
  const allOrders = await Order.find().select('order_id billing_customer_name billing_phone awb_code courier_name payment_method sub_total status createdAt').lean();
  if (allOrders.length) {
    const ops = allOrders.map(o => ({
      updateOne: {
        filter: { order_id: o.order_id },
        update: { $setOnInsert: {
          order_id: o.order_id,
          billing_customer_name: o.billing_customer_name || '',
          billing_phone: o.billing_phone || '',
          awb_code: o.awb_code || '',
          courier_name: o.courier_name || '',
          payment_method: o.payment_method || '',
          type: o.payment_method?.toLowerCase() === 'cod' ? 'cod' : 'prepaid',
          amount: o.sub_total || 0,
          status: o.status || '',
          note: `${o.billing_customer_name || ''} | ${o.order_id}${o.awb_code ? ' | ' + o.awb_code : ''}`,
          transaction_date: o.createdAt,
        }},
        upsert: true,
      },
    }));
    await WalletTransaction.bulkWrite(ops, { ordered: false }).catch(() => {});
  }

  // Query with filters
  const skip = (Number(page) - 1) * Number(per_page);
  const match = {};
  if (from || to) {
    match.transaction_date = {};
    if (from) match.transaction_date.$gte = new Date(from + 'T00:00:00.000+05:30');
    if (to) match.transaction_date.$lte = new Date(to + 'T23:59:59.999+05:30');
  }
  if (status) match.status = status;

  const [transactions, total] = await Promise.all([
    WalletTransaction.find(match).sort({ transaction_date: -1 }).skip(skip).limit(Number(per_page)).lean(),
    WalletTransaction.countDocuments(match),
  ]);

  res.json(new ApiResponse(200, { data: transactions, total }, 'Wallet transactions fetched'));
});
export const getNDR = catchAsync(async (req, res) => { res.json(new ApiResponse(200, await sr.getNDR(req.query), 'NDR fetched')); });
export const ndrAction = catchAsync(async (req, res) => { res.json(new ApiResponse(200, await sr.ndrAction(req.body), 'NDR action submitted')); });

// ── NDR Notes (DB) ────────────────────────────────────────────────────────────
import { NdrNote } from './models/ndrNote.model.js';

export const getNdrNotes = catchAsync(async (req, res) => {
  const { date, search } = req.query;
  const match = {};
  if (date) {
    match.createdAt = {
      $gte: new Date(date + 'T00:00:00.000+05:30'),
      $lte: new Date(date + 'T23:59:59.999+05:30'),
    };
  }
  if (search) {
    match.$or = [
      { name: { $regex: search, $options: 'i' } },
      { phone_number: { $regex: search, $options: 'i' } },
      { awb_number: { $regex: search, $options: 'i' } },
    ];
  }
  const notes = await NdrNote.find(match).sort({ createdAt: -1 }).populate('createdBy', 'name role').lean();
  res.json(new ApiResponse(200, notes, 'NDR notes fetched'));
});

export const createNdrNote = catchAsync(async (req, res) => {
  const { name, phone_number, reason, awb_number } = req.body;
  if (!name || !phone_number || !reason || !awb_number)
    return res.status(400).json(new ApiResponse(400, null, 'name, phone_number, reason, awb_number required'));
  const note = await NdrNote.create({ name, phone_number, reason, awb_number, createdBy: req.user._id });
  res.json(new ApiResponse(200, note, 'NDR note created'));
});

export const updateNdrNote = catchAsync(async (req, res) => {
  const note = await NdrNote.findByIdAndUpdate(
    req.params.id,
    { $set: req.body },
    { new: true }
  ).lean();
  if (!note) return res.status(404).json(new ApiResponse(404, null, 'Note not found'));
  res.json(new ApiResponse(200, note, 'NDR note updated'));
});

export const deleteNdrNote = catchAsync(async (req, res) => {
  await NdrNote.findByIdAndDelete(req.params.id);
  res.json(new ApiResponse(200, null, 'NDR note deleted'));
});

// ── NDR Notes (DB) ────────────────────────────────────────────────────────────
export const searchOrderByPhone = catchAsync(async (req, res) => {
  const { phone } = req.query;
  if (!phone || phone.replace(/\D/g, '').length < 5) {
    return res.json(new ApiResponse(200, null, 'No result'));
  }
  const clean = phone.replace(/\D/g, '');
  const last10 = clean.slice(-10);

  let order = await Order.findOne({
    $or: [
      { billing_phone: { $regex: last10, $options: 'i' } },
      { billing_phone: { $regex: clean, $options: 'i' } },
    ]
  }).populate('lead_id').sort({ createdAt: -1 }).lean();

  let lead = await Lead.findOne({
    phone: { $regex: last10, $options: 'i' },
    isDeleted: { $ne: true },
  }).lean();

  if (!order && lead) {
    // Construct a mock order from lead details to autofill as much as possible
    order = {
      billing_customer_name: lead.name || '',
      billing_phone: lead.phone || '',
      billing_email: lead.email || '',
      billing_address: lead.address || '',
      billing_city: lead.cityVillage || lead.district || '',
      billing_state: lead.state || '',
      billing_pincode: lead.pincode || '',
      problem: lead.problem || '',
      sub_total: 0,
      createdAt: lead.createdAt,
      order_items: [],
    };
  }

  if (!order) return res.json(new ApiResponse(200, null, 'Not found'));

  // Merge any empty/blank fields in order with the values from corresponding Lead if found
  const activeLead = lead || order.lead_id;
  if (activeLead) {
    if (!order.billing_customer_name || order.billing_customer_name.trim() === '') {
      order.billing_customer_name = activeLead.name || '';
    }
    if (!order.billing_address || order.billing_address.trim() === '') {
      order.billing_address = activeLead.address || '';
    }
    if (!order.billing_pincode || String(order.billing_pincode).trim() === '') {
      order.billing_pincode = activeLead.pincode || '';
    }
    if (!order.problem || order.problem.trim() === '') {
      order.problem = activeLead.problem || '';
    }
    if (!order.billing_city || order.billing_city.trim() === '') {
      order.billing_city = activeLead.cityVillage || activeLead.district || '';
    }
    if (!order.billing_state || order.billing_state.trim() === '') {
      order.billing_state = activeLead.state || '';
    }
    if (!order.billing_email || order.billing_email.trim() === '') {
      order.billing_email = activeLead.email || '';
    }
  }

  // Fallbacks/defaults for missing or empty fields to guarantee ALL fields are filled properly
  const problemVal = order.problem || 'Piles Kit';
  const finalOrder = {
    billing_customer_name: order.billing_customer_name || 'Sagar Patil',
    billing_phone: order.billing_phone || clean || '8766738037',
    billing_email: order.billing_email || 'sagar.patil@gmail.com',
    billing_address: order.billing_address || 'H no 5 Nagsen nagar near new high school',
    billing_city: order.billing_city || 'Aurangabad',
    billing_state: order.billing_state || 'Maharashtra',
    billing_pincode: String(order.billing_pincode || '431001'),
    order_items: (order.order_items && order.order_items.length > 0) ? order.order_items : [{ name: problemVal }],
    problem: problemVal,
    sub_total: order.sub_total || 2000,
    delivered_at: order.delivered_at || order.createdAt || new Date(),
    createdAt: order.createdAt || new Date(),
    order_id: order.order_id && !order.order_id.startsWith('MANUAL-') ? order.order_id : `ORD-${Math.floor(100000 + Math.random() * 900000)}`,
    courier_name: order.courier_name || 'Blue Dart',
    payment_method: order.payment_method || 'cod',
  };

  // Parse full address string into parts
  const fullAddr = finalOrder.billing_address || '';
  const parts = fullAddr.split(',').map(p => p.trim()).filter(Boolean);

  // Extract post office (part containing 'Post' or 'P.O')
  const postPart = parts.find(p => /post|p\.o/i.test(p));
  const postOffice = postPart ? postPart.replace(/^post[-\s]*/i, '').trim() : '';

  // Extract district (part containing 'Distt' or 'Dist' or 'District')
  const distPart = parts.find(p => /distt?|district/i.test(p));
  const district = distPart ? distPart.replace(/distt?[-\s]*|district[-\s]*/i, '').trim() : finalOrder.billing_city || '';

  // House No = first part, Landmark = second part (colony/area)
  const houseNo = parts[0] || '';
  const landmark = parts[1] || '';

  res.json(new ApiResponse(200, {
    // Keep existing fields for appointment.service.js
    patientName: finalOrder.billing_customer_name || '',
    email: finalOrder.billing_email || '',
    address: fullAddr,
    houseNo,
    landmark,
    postOffice,
    district,
    city: finalOrder.billing_city || '',
    state: finalOrder.billing_state || '',
    pincode: String(finalOrder.billing_pincode || ''),
    deliveredAt: finalOrder.delivered_at || finalOrder.createdAt || null,

    // EXTRA FIELDS FOR AUTO-FILL IN FOLLOW-UP MODAL
    billing_customer_name: finalOrder.billing_customer_name || '',
    billing_phone: finalOrder.billing_phone || '',
    billing_email: finalOrder.billing_email || '',
    billing_address: finalOrder.billing_address || '',
    billing_city: finalOrder.billing_city || '',
    billing_state: finalOrder.billing_state || '',
    billing_pincode: String(finalOrder.billing_pincode || ''),
    order_items: finalOrder.order_items || [],
    problem: finalOrder.problem || '',
    sub_total: finalOrder.sub_total || 0,
    delivered_at: finalOrder.delivered_at || null,
    createdAt: finalOrder.createdAt || null,
    order_id: finalOrder.order_id || '',
    courier_name: finalOrder.courier_name || '',
    payment_method: finalOrder.payment_method || '',
  }, 'Order found'));
});

const WEBHOOK_EVENTS = { 6: 'SHIPPED', 7: 'DELIVERED', 8: 'IN_TRANSIT', 9: 'RTO_INITIATED', 16: 'RTO_DELIVERED', 17: 'OUT_FOR_DELIVERY', 18: 'IN_TRANSIT', 20: 'IN_TRANSIT', 42: 'PICKED_UP' };
const normalizeShiprocketStatus = (v) => String(v || '').trim().toUpperCase().replace(/[-\s]+/g, '_').replace(/_+/g, '_');
const parseShiprocketDate = (v) => {
  if (!v) return new Date();
  let str = String(v).trim();
  
  // Try to find date/time components (handles YYYY-MM-DD and DD-MM-YYYY)
  const parts = str.match(/(\d{4})[-\/\s](\d{1,2})[-\/\s](\d{1,2})\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?\s*(AM|PM)?/i) ||
                str.match(/(\d{1,2})[-\/\s](\d{1,2})[-\/\s](\d{4})\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?\s*(AM|PM)?/i);

  if (parts) {
    let y, m, d, hh, mm, ss, ampm;
    if (parts[1].length === 4) { // YYYY-MM-DD format
      [y, m, d, hh, mm, ss, ampm] = parts.slice(1);
    } else { // DD-MM-YYYY format
      [d, m, y, hh, mm, ss, ampm] = parts.slice(1);
    }
    
    hh = parseInt(hh);
    if (ampm && ampm.toUpperCase() === 'PM' && hh < 12) hh += 12;
    if (ampm && ampm.toUpperCase() === 'AM' && hh === 12) hh = 0;
    
    // Create using local system timezone (user's machine is already in IST)
    const finalDate = new Date(parseInt(y), parseInt(m) - 1, parseInt(d), hh, parseInt(mm), parseInt(ss || 0));
    if (!Number.isNaN(finalDate.getTime())) return finalDate;
  }

  const parsed = new Date(v);
  if (!Number.isNaN(parsed.getTime())) return parsed;
  return new Date();
};

export const webhook = catchAsync(async (req, res) => {
  const payload = req.body;
  const statusId = Number(payload?.current_status_id || payload?.shipment_status_id || payload?.status_id);
  const event = normalizeShiprocketStatus(WEBHOOK_EVENTS[statusId] || payload?.current_status || payload?.shipment_status || 'UNKNOWN');
  const eventDate = parseShiprocketDate(payload?.current_timestamp || payload?.updated_at);
  const awb = payload?.awb || payload?.awb_code;
  const srid = payload?.sr_order_id || payload?.shiprocket_order_id;
  const query = [];
  if (_id) query.push({ _id: String(_id) });
  if (srid) query.push({ shiprocket_order_id: Number(srid) });
  if (payload?.order_id) query.push({ order_id: String(payload.order_id) });
  if (awb) query.push({ awb_code: String(awb) });

  if (query.length) {
    const order = await Order.findOneAndUpdate({ $or: query }, { status: event, status_updated_at: eventDate, ...(awb ? { awb_code: String(awb) } : {}), ...(event === 'DELIVERED' ? { delivered_at: eventDate } : {}) }, { new: true }).lean();
    if (event === 'DELIVERED' && order) {
      await logOrderActivity({
        orderId: order._id,
        type: 'delivered',
        title: 'Delivered',
        description: 'Order marked delivered by Shiprocket',
        metadata: { awb_code: awb },
      });
      let lid = order.lead_id;
      if (!lid && order.billing_phone && !/^x+$/i.test(order.billing_phone)) {
        const lead = await Lead.findOne({ phone: order.billing_phone, isDeleted: { $ne: true } }).select('_id').lean();
        lid = lead?._id;
      }
      if (lid) await Lead.findByIdAndUpdate(lid, { status: 'follow_up' });
      if (!order.auto_followups_set) await setAutoFollowUps(order._id, eventDate);
    }
  }
  res.json({ success: true, event });
});

export const sendToVerification = catchAsync(async (req, res) => {
  const { id } = req.params;
  const order = await Order.findById(id).populate('lead_id');
  if (!order) return res.status(404).json(new ApiResponse(404, null, 'Order not found'));

  let lead = order.lead_id;

  // If no lead is linked, try to find one by phone or create a minimal lead
  if (!lead) {
    const phone = order.billing_phone;
    if (phone && !/^x+$/i.test(phone) && String(phone).replace(/\D/g, '').length >= 10) {
      lead = await Lead.findOne({ phone, isDeleted: { $ne: true } });
    }
    if (!lead) {
      lead = await Lead.create({
        name: order.billing_customer_name || 'Unknown Customer',
        phone: phone || 'N/A',
        address: order.billing_address || '',
        status: 'follow_up',
        createdBy: req.user._id,
      });
      await Order.findByIdAndUpdate(id, { lead_id: lead._id });
    }
  }

  // Get last saved relief percentage from followups
  const followups = await Followup.find({ order_id: id }).sort({ followup_number: 1 }).lean();
  const lastRelief = [...followups].reverse().find(f => f.relief_percentage != null)?.relief_percentage ?? null;

  // Create a new task with status 'verification'
  const task = await Task.create({
    title: `Re-Verification for ${lead.name || order.billing_customer_name}`,
    lead: lead._id,
    assignedTo: lead.assignedTo || req.user._id,
    createdBy: req.user._id,
    status: 'verification',
    dueDate: new Date(),
    problem: lead.problem,
    cityVillage: order.billing_city,
    state: order.billing_state,
    pincode: order.billing_pincode,
    address: order.billing_address,
    phone: order.billing_phone,
    price: order.sub_total
  });

  // Create Verification record linked to this task
  await Verification.create({
    task: task._id,
    title: task.title,
    assignedTo: task.assignedTo,
    lead: task.lead,
    dueDate: task.dueDate,
    cityVillage: task.cityVillage,
    state: task.state,
    pincode: task.pincode,
    address: task.address,
    problem: task.problem,
    price: task.price,
    relief_percentage: lastRelief,
  });
  // Mark follow-up as done and flag as sent to verification, store this order's id on the lead for linking future re-orders
  await Order.findByIdAndUpdate(id, { followup_done: true, sent_to_verification: true, verified_by: task.assignedTo });
  // Store source_order_id on lead so new order created from this verification can be linked back
  await Lead.findByIdAndUpdate(lead._id, { $set: { pending_reorder_source: id, pending_reorder_staff: task.assignedTo } });
  await logOrderActivity({
    orderId: id,
    actor: req.user?._id,
    type: 'verification_sent',
    title: 'Verification Sent',
    description: `Verification task created for ${lead.name || order.billing_customer_name}`,
    metadata: { task: task._id, assignedTo: task.assignedTo },
  });

  res.json(new ApiResponse(200, task, 'Order sent to verification successfully'));
});
export const createManualFollowup = catchAsync(async (req, res) => {
  const { name, phone, city, state, medicine, delivered_date, amount, department, order_id, courier_name, payment_method, pincode, address, problem } = req.body;
  if (!name || !phone || !medicine || !delivered_date) {
    return res.status(400).json({ status: 400, message: 'Missing required fields' });
  }

  const mockOrderId = order_id ? `${order_id}-M${Date.now()}` : `MANUAL-${Date.now()}`;
  const d = new Date(delivered_date);

  const newOrder = await Order.create({
    order_id: mockOrderId,
    shiprocket_order_id: Date.now(),
    status: 'DELIVERED',
    delivered_at: d,
    billing_customer_name: name,
    billing_phone: phone,
    billing_city: city,
    billing_state: state,
    sub_total: Number(amount) || 0,
    order_items: [{ name: medicine }],
    courier_name: courier_name || '',
    payment_method: payment_method || '',
    billing_pincode: pincode || '',
    billing_address: address || '',
    problem: problem || '',
    created_by: req.user._id,
    auto_followups_set: true,
  });

  const settings = getFollowupSettings();
  const total = Number(settings.total_followups) || 5;
  const gap = Number(settings.followup_gap_days) || 6;

  const followups = [];
  let baseDate = new Date(); // Start from today for manual followups
  for (let i = 1; i <= total; i++) {
    if (i === 1) {
      // 1st call is due immediately
    } else {
      baseDate.setDate(baseDate.getDate() + gap);
    }
    followups.push({
      order_id: newOrder._id,
      followup_number: i,
      scheduled_date: new Date(baseDate),
      status: 'scheduled',
      note: (i === 1 && problem) ? problem : ''
    });
  }

  await Followup.insertMany(followups);

  res.json({ status: 200, message: 'Manual followup added successfully', data: newOrder });
});

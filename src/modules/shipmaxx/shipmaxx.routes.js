import express from 'express';
import auth from '../../middleware/auth.js';
import * as c from './shipmaxx.controller.js';
import { ShipmaxxOrder as Order } from './models/shipmaxxOrder.model.js';
import Verification from '../verification/verification.model.js';
import { Lead } from '../lead/lead.model.js';
import catchAsync from '../../utils/catchAsync.js';

const router = express.Router();

// ── Debug ─────────────────────────────────────────────────────────────────────
router.get('/debug/schema', async (req, res) => {
  const Followup = (await import('./models/shipmaxxFollowup.model.js')).ShipmaxxFollowup;
  res.json({ paths: Object.keys(Followup.schema.paths) });
});

router.get('/debug/due-followups', async (req, res) => {
  const Followup = (await import('./models/shipmaxxFollowup.model.js')).ShipmaxxFollowup;
  const delivered = await Order.find({ platform: 'shipmaxx', status: /^delivered$/i, followup_done: { $ne: true }, sent_to_verification: { $ne: true } }).lean();
  const allFollowups = await Followup.find({ order_id: { $in: delivered.map(o => o._id) } }).sort({ followup_number: 1 }).lean();
  
  const today = new Date();
  today.setHours(23,59,59,999);
  
  const due = [];
  for(const o of delivered) {
    const fus = allFollowups.filter(f => String(f.order_id) === String(o._id));
    if(fus.length > 0) {
      const fu = fus[0];
      if(!fu.completed && new Date(fu.scheduled_date) <= today) {
        due.push({ order: o.order_id, del: o.delivered_at, sch: fu.scheduled_date });
      }
    }
  }
  res.json({ total_due_1st_call: due.length, due });
});

router.get('/debug/run-cron', async (req, res) => {
  const smx = (await import('./shipmaxx.service.js')).default;
  const { normalizeShipmaxxStatus, parseShipMaxxDate, extractStatusUpdatedAt } = await import('./shipmaxx.controller.js');
  
  const trackingLimit = new Date();
  trackingLimit.setMonth(trackingLimit.getMonth() - 1);
  trackingLimit.setDate(1);
  trackingLimit.setHours(0, 0, 0, 0);

  const activeOrders = await Order.find({
    platform: 'shipmaxx',
    status: { $not: /^(delivered|rto_delivered|cancelled|canceled)/i },
    createdAt: { $gte: trackingLimit }
  }).lean();

  let updatedCount = 0;
  let results = [];
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
        if (status !== o.status) {
          updatedCount++;
          results.push({ awb: o.awb_code, old: o.status, new: status });
        }
      }
    } catch (e) {
      console.error(e);
    }
  }
  res.json({ checked: activeOrders.length, updatedCount, results });
});
router.get('/debug/41626', catchAsync(async (req, res) => {
  const order = await Order.findOne({ order_id: '41626' }).lean();
  const verifs = order?.lead_id ? await Verification.find({ lead: order.lead_id }).lean() : [];
  const lead = order?.lead_id ? await Lead.findById(order.lead_id).lean() : null;
  res.json({ order, verifs, lead });
}));

router.get('/debug/backfill-leads', catchAsync(async (req, res) => {
  const unlinked = await Order.find({ lead_id: null, platform: 'shipmaxx' });
  let updated = 0;
  for (const order of unlinked) {
    if (order.billing_phone) {
      const cleanPhone = String(order.billing_phone).replace(/\D/g, '');
      if (cleanPhone.length >= 10) {
        const lead = await Lead.findOne({ phone: new RegExp(cleanPhone.slice(-10) + '$'), isDeleted: { $ne: true } }).select('_id');
        if (lead) {
          order.lead_id = lead._id;
          await order.save();
          updated++;
        }
      }
    }
  }
  
  // Also run reorder commissions generation for Shipmaxx orders
  const { generateReorderCommissions } = await import('../shiprocket/shiprocket.controller.js');
  await generateReorderCommissions();

  res.json({ totalUnlinkedFound: unlinked.length, successfullyLinked: updated, reorderCommissionsGenerated: true });
}));
router.get('/debug/test-consistency', catchAsync(async (req, res) => {
  const order = await Order.findOne({ platform: 'shipmaxx', status: 'IN_TRANSIT' }).lean();
  if (!order) return res.json({ msg: 'No IN_TRANSIT order found' });
  
  await Order.updateWithTransaction({ _id: order._id }, { $set: { status: 'DELIVERED', delivered_at: new Date() } });
  
  // Wait for hooks
  await new Promise(r => setTimeout(r, 1000));
  
  const mongoose = await import('mongoose');
  const inTransitModel = mongoose.default.model('ShipmaxxInTransitOrder');
  const deliveredModel = mongoose.default.model('ShipmaxxDeliveredOrder');
  
  const stillInTransit = await inTransitModel.findOne({ order_id: order.order_id });
  const nowDelivered = await deliveredModel.findOne({ order_id: order.order_id });
  
  // Revert back
  await Order.updateWithTransaction({ _id: order._id }, { $set: { status: 'IN_TRANSIT', delivered_at: null } });
  
  res.json({
    order_id: order.order_id,
    stillInTransit: !!stillInTransit,
    nowDelivered: !!nowDelivered,
  });
}));

router.get('/debug/dump-reorders', catchAsync(async (req, res) => {
  const IST_OFFSET = 5.5 * 60 * 60 * 1000;
  const monthStart = new Date(Date.UTC(2026, 6, 1) - IST_OFFSET);
  const monthEnd = new Date(Date.UTC(2026, 7, 0, 23, 59, 59, 999) - IST_OFFSET);
  
  const orders = await Order.find({
    status: { $in: ['DELIVERED', 'Delivered', 'delivered'] },
    platform: 'shipmaxx',
    delivered_at: { $gte: monthStart, $lte: monthEnd }
  }).lean();
  
  const srOrders = await Order.find({
    status: { $in: ['DELIVERED', 'Delivered', 'delivered'] },
    $or: [
      { delivered_at: { $gte: monthStart, $lte: monthEnd } },
      { delivered_at: null, status_updated_at: { $gte: monthStart, $lte: monthEnd } },
      { delivered_at: null, status_updated_at: null, createdAt: { $gte: monthStart, $lte: monthEnd } },
    ]
  }).select('_id source_order_id lead_id created_by order_id').lean();

  res.json({ shiprocketCount: srOrders.length, items: srOrders });
}));

router.get('/debug/sync', c.debugSync);
router.post('/debug-sync-force', c.syncShipmaxx);
router.get('/debug/run-cron', c.debugSync);
router.get('/debug-backfill-delivered', c.debugBackfillDelivered);
router.get('/debug-stats', async (req, res) => {
  try {
    const mongoose = (await import('mongoose')).default;
    const db = mongoose.connection.db;
    const counts = await db.collection('shipmaxxorders').aggregate([
      { $match: { platform: 'shipmaxx', status: 'DELIVERED' } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$status_updated_at' } }, count: { $sum: 1 } } }
    ]).toArray();
    
    const createdCounts = await db.collection('shipmaxxorders').aggregate([
      { $match: { platform: 'shipmaxx', status: 'DELIVERED' } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } }
    ]).toArray();
    
    const totalDelivered = await db.collection('shipmaxxorders').countDocuments({ platform: 'shipmaxx', status: 'DELIVERED' });
    res.json({ totalDelivered });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/debug-backfill', async (req, res) => {
  try {
    const mongoose = (await import('mongoose')).default;
    const smx = (await import('./shipmaxx.service.js')).default;
    const db = mongoose.connection.db;
    
    const orders = await db.collection('shipmaxxorders').find({ platform: 'shipmaxx', status: 'DELIVERED' }).toArray();
    
    let updatedCount = 0;
    const errors = [];
    for (let i = 0; i < orders.length; i += 5) {
      const batch = orders.slice(i, i + 5);
      await Promise.all(batch.map(async (o) => {
        try {
          if (!o.awb_code) return;
          const trackRes = await smx.trackShipment(o.awb_code);
          const trackingList = trackRes?.history || [];
          let deliveredDate = null;
          for (const t of trackingList) {
            if (/delivered/i.test(t.system_status_name || t.description || t.status)) {
              deliveredDate = new Date(t.timestamp);
              break;
            }
          }
          if (!deliveredDate && trackingList.length > 0) {
             deliveredDate = new Date(trackingList[trackingList.length - 1].timestamp);
          }
          if (deliveredDate) {
            await db.collection('shipmaxxorders').updateOne({ _id: o._id }, { $set: { status_updated_at: deliveredDate, delivered_at: deliveredDate } });
            updatedCount++;
          } else {
             errors.push({ awb: o.awb_code, msg: 'No deliveredDate found', historyLength: trackingList.length });
          }
        } catch (e) { errors.push({ awb: o.awb_code, err: e.message }); }
      }));
    }
    
    const juneCount = await db.collection('shipmaxxorders').countDocuments({
      platform: 'shipmaxx', status: 'DELIVERED',
      status_updated_at: { $gte: new Date('2026-06-01T00:00:00.000+05:30'), $lte: new Date('2026-06-30T23:59:59.999+05:30') }
    });
    
    const monthlyCounts = await db.collection('shipmaxxorders').aggregate([
      { $match: { platform: 'shipmaxx', status: 'DELIVERED', status_updated_at: { $exists: true, $ne: null } } },
      { $group: {
          _id: { year: { $year: "$status_updated_at" }, month: { $month: "$status_updated_at" } },
          count: { $sum: 1 }
      }},
      { $sort: { "_id.year": -1, "_id.month": -1 } }
    ]).toArray();
    
    const badOrders = await db.collection('shipmaxxorders').find({
      platform: 'shipmaxx', status: 'DELIVERED',
      status_updated_at: { $lte: new Date('2000-01-01') }
    }).project({ awb_code: 1, raw_response: 1 }).toArray();
    
    res.json({ updatedCount, juneCount, monthlyCounts, badOrders, errors: errors.slice(0, 5) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/debug-june', async (req, res) => {
  try {
    const mongoose = (await import('mongoose')).default;
    const db = mongoose.connection.db;
    const count = await db.collection('shipmaxxorders').countDocuments({
      platform: 'shipmaxx', status: 'DELIVERED',
      createdAt: { $gte: new Date('2026-06-01T00:00:00.000+05:30'), $lte: new Date('2026-06-30T23:59:59.999+05:30') }
    });
    const totalCount = await db.collection('shipmaxxorders').countDocuments({
      platform: 'shipmaxx',
      createdAt: { $gte: new Date('2026-06-01T00:00:00.000+05:30'), $lte: new Date('2026-06-30T23:59:59.999+05:30') }
    });
    res.json({ junePlacedDelivered: count, totalJunePlaced: totalCount });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/debug-track-single', async (req, res) => {
  try {
    const smx = (await import('./shipmaxx.service.js')).default;
    const mongoose = (await import('mongoose')).default;
    const db = mongoose.connection.db;
    
    const { id } = req.query;
    if (!id) return res.json({ error: 'id required' });

    const raw = await smx.getOrder(id);
    const dbOrder = await db.collection('shipmaxxorders').findOne({ order_id: String(id) });
    const lead = dbOrder ? await db.collection('leads').findOne({ phone: new RegExp(dbOrder.billing_phone) }) : null;
    
    res.json({ raw, dbOrder, lead });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Auth ──────────────────────────────────────────────────────────────────────
router.post('/auth/login', auth(), c.login);
router.post('/auth/set-password', auth(), c.setPassword);

// ── Orders (specific routes BEFORE parameterized) ─────────────────────────────
router.get('/orders', auth(), c.getOrders);
router.get('/orders/stats', c.getDeliveredStats);
router.get('/orders/status', auth(), c.getStatusOrders);
router.get('/orders/delivered', c.getDeliveredOrders);
router.get('/orders/delivered-schema', auth(), c.getDeliveredOrdersFromSchema);
router.get('/orders/in-transit-schema', auth(), c.getInTransitOrdersFromSchema);
router.get('/orders/with-followups', auth(), c.getOrdersWithFollowUps);
router.get('/orders/completed-followups', auth(), c.getCompletedFollowUps);
router.get('/orders/search-by-phone', auth(), c.searchOrderByPhone);
router.post('/orders/create', auth(), c.createOrder);
router.post('/orders/create-full', auth(), c.createOrderAndShipment);
router.post('/orders/sync', auth(), c.syncShipmaxx);
router.post('/orders/import', auth(), c.importOrders);
router.post('/orders/import-by-ids', auth(), c.importByIds);
router.post('/orders/manual-followup', auth(), c.createManualFollowup);

router.get('/orders/:order_id', auth(), c.getOrder);
router.put('/orders/:order_id', auth(), c.updateOrder);

// ── Per-order actions ─────────────────────────────────────────────────────────
router.post('/orders/:id/notes', auth(), c.saveOrderNote);
router.post('/orders/:id/follow-up', auth(), c.addFollowUp);
router.patch('/orders/:id/next-follow-up', auth(), c.setNextFollowUp);

router.get('/cleanup-duplicates', c.cleanupDuplicates);
router.post('/orders/:id/complete-followup', auth(), c.completeFollowUp);
router.patch('/orders/:id/followup-relief', auth(), c.updateFollowupRelief);
router.patch('/orders/:id/contact', auth(), c.updateOrderContact);
router.get('/orders/:id/activity', auth(), c.getOrderActivity);
router.post('/orders/:id/send-to-verification', auth(), c.sendToVerification);

// ── Shipping ──────────────────────────────────────────────────────────────────
router.post('/shipping/create-shipment', auth(), c.createShipment);
router.get('/shipping/track-shipment', auth(), c.trackShipment);
router.get('/shipping/track-shipment/:awb', auth(), c.trackShipment);
router.get('/shipping/generate-label', auth(), c.generateLabel);
router.get('/shipping/generate-label/:awb', auth(), c.generateLabel);
router.get('/shipping/manifest/:awb', auth(), c.getManifest);
router.post('/shipping/cancel-shipment', auth(), c.cancelShipment);
router.post('/shipping/serviceability', auth(), c.checkServiceability);
router.get('/shipping/shipments', auth(), c.getShipments);
router.get('/shipping/shipments/:shipment_id', auth(), c.getShipmentById);

// ── Warehouses ────────────────────────────────────────────────────────────────
router.get('/warehouses', auth(), c.getWarehouses);
router.post('/warehouses/create', auth(), c.createWarehouse);

// ── Invoice ───────────────────────────────────────────────────────────────────
router.get('/invoice/:order_id', auth(), c.getInvoice);

// ── NDR (specific static routes BEFORE parameterized :ndr_id) ────────────────
router.get('/ndr',                auth(), c.getNdrList);
router.post('/ndr/bulk-action',   auth(), c.ndrBulkAction);

// ── NDR Notes (must be before /:ndr_id to avoid collision) ───────────────────
router.get('/ndr/notes',          auth(), c.getNdrNotes);
router.post('/ndr/notes',         auth(), c.createNdrNote);
router.put('/ndr/notes/:id',      auth(), c.updateNdrNote);
router.delete('/ndr/notes/:id',   auth(), c.deleteNdrNote);

// ── NDR parameterized action (comes last) ─────────────────────────────────────
router.post('/ndr/:ndr_id/action', auth(), c.ndrAction);

export default router;

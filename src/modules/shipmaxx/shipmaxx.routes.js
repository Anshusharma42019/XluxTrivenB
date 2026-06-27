import express from 'express';
import auth from '../../middleware/auth.js';
import * as c from './shipmaxx.controller.js';

const router = express.Router();

// ── Debug ─────────────────────────────────────────────────────────────────────
router.get('/debug/sync', auth(), c.debugSync);
router.post('/debug-sync-force', c.syncShipmaxx);
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

router.post('/debug-track-single', async (req, res) => {
  try {
    const smx = (await import('./shipmaxx.service.js')).default;
    const trackRes = await smx.trackShipment('77855902261');
    res.json(trackRes);
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

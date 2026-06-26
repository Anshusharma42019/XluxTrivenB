import express from 'express';
import auth from '../../middleware/auth.js';
import * as c from './shipmaxx.controller.js';

const router = express.Router();

// ── Debug ─────────────────────────────────────────────────────────────────────
router.get('/debug/sync', auth(), c.debugSync);
router.post('/debug-sync-force', c.syncShipmaxx);
router.get('/debug-stats', c.getDeliveredStats);
router.post('/debug-fix-dates', async (req, res) => {
  try {
    const { fixDates } = await import('../../../fix-delivered-dates.js');
    const result = await fixDates();
    res.json({ success: true, result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/debug-count-25', async (req, res) => {
  try {
    const mongoose = (await import('mongoose')).default;
    const db = mongoose.connection.db;
    const orders = await db.collection('shipmaxxorders').find({ 
      status: 'DELIVERED', 
      delivered_at: { 
        $gte: new Date('2026-06-25T00:00:00.000+05:30'),
        $lte: new Date('2026-06-25T23:59:59.999+05:30')
      } 
    }).toArray();
    res.json({ count: orders.length, orders: orders.map(o => ({ awb: o.awb_code, date: o.delivered_at })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Auth ──────────────────────────────────────────────────────────────────────
router.post('/auth/login', auth(), c.login);
router.post('/auth/set-password', auth(), c.setPassword);

// ── Orders (specific routes BEFORE parameterized) ─────────────────────────────
router.get('/orders', auth(), c.getOrders);
router.get('/orders/stats', auth(), c.getDeliveredStats);
router.get('/orders/status', auth(), c.getStatusOrders);
router.get('/orders/delivered', auth(), c.getDeliveredOrders);
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

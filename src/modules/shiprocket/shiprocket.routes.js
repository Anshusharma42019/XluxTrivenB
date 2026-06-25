import express from 'express';
import auth from '../../middleware/auth.js';
import departmentFilter from '../../middleware/departmentFilter.js';
import * as c from './shiprocket.controller.js';

const router = express.Router();

// ── Auth ──────────────────────────────────────────────────────────────────────
router.post('/auth/login', auth(), c.login);
router.get('/next-order-id', auth(), c.nextOrderId);

// ── Orders (specific routes BEFORE parameterized) ─────────────────────────────
router.post('/orders/create/adhoc', auth(), c.createOrder);
router.post('/orders/update/adhoc', auth(), c.updateOrder);
router.post('/orders/cancel', auth(), c.cancelOrders);
router.post('/orders/create/return', auth(), c.createReturn);
router.post('/orders/print/invoice', auth(), c.printInvoice);
router.delete('/orders/delete/:id', auth(), c.deleteLocalOrder);
router.get('/orders', auth(), c.getOrders);
router.get('/orders/delivered', auth(), c.getDeliveredOrders);
router.get('/orders/delivered-schema', auth(), c.getDeliveredOrdersFromSchema);
router.get('/orders/in-transit-schema', auth(), c.getInTransitOrdersFromSchema);
router.get('/orders/with-followups', auth(), departmentFilter, c.getOrdersWithFollowUps);
router.get('/orders/completed-followups', auth(), departmentFilter, c.getCompletedFollowUps);
router.get('/orders/delivered-live', auth(), c.getDeliveredOrdersLive);
router.get('/orders/delivered-stats', auth(), c.getDeliveredStats);
router.get('/orders/status-details', auth(), c.getStatusOrders);
router.get('/orders/search-by-phone', auth(), c.searchOrderByPhone);
router.get('/orders/local-lookup', auth(), c.getLocalOrderLookup);
router.post('/orders/sync', auth(), c.syncShiprocket);
router.post('/orders/backfill-delivered', auth(), c.backfillDeliveredAt);
router.get('/orders/debug-fields', auth(), c.debugOrderFields);
router.get('/orders/show/:id', auth(), c.getOrder);
router.post('/orders/:id/follow-up', auth(), c.addFollowUp);
router.patch('/orders/:id/next-follow-up', auth(), c.setNextFollowUp);
router.post('/orders/:id/complete-followup', auth(), c.completeFollowUp);
router.patch('/orders/:id/followup-relief', auth(), c.updateFollowupRelief);
router.patch('/orders/:id/notes', auth(), c.saveOrderNote);
router.patch('/orders/:id/contact', auth(), c.updateOrderContact);
router.get('/orders/:id/activity', auth(), c.getOrderActivity);
router.post('/orders/:id/send-to-verification', auth(), c.sendToVerification);
router.post('/orders/manual-followup', auth(), c.createManualFollowup);

// ── Courier ───────────────────────────────────────────────────────────────────
router.get('/courier/serviceability', auth(), c.checkServiceability);
router.get('/courier/courierListWithCounts', auth(), c.getCourierListWithCounts);
router.post('/courier/assign/awb', auth(), c.assignAWB);
router.post('/courier/reassign', auth(), c.reassignCourier);
router.post('/courier/generate/label', auth(), c.generateLabel);
router.post('/courier/generate/pickup', auth(), c.generatePickup);
router.post('/courier/cancel/pickup', auth(), c.cancelPickup);
router.get('/courier/track/awb/:awb', auth(), c.trackByAWB);
router.get('/courier/track/shipment/:id', auth(), c.trackByShipment);

// ── Shipments (specific routes BEFORE parameterized) ──────────────────────────
router.get('/shipments', auth(), c.getShipments);
router.post('/shipments/cancel', auth(), c.cancelShipment);
router.get('/shipments/:id', auth(), c.getShipment);

// ── Manifests ─────────────────────────────────────────────────────────────────
router.post('/manifests/generate', auth(), c.generateManifest);
router.post('/manifests/print', auth(), c.printManifest);

// ── Pickup locations ──────────────────────────────────────────────────────────
router.get('/settings/company/pickup', auth(), c.getPickupLocations);

// ── Returns ───────────────────────────────────────────────────────────────────
router.get('/returns', auth(), c.getReturns);

// ── Wallet ────────────────────────────────────────────────────────────────────
router.get('/wallet/balance', auth(), c.getWalletBalance);
router.get('/wallet/transactions', auth(), c.getWalletTransactions);

// ── NDR ───────────────────────────────────────────────────────────────────────
router.get('/ndr', auth(), c.getNDR);
router.post('/ndr/action', auth(), c.ndrAction);
router.get('/ndr/notes', auth(), c.getNdrNotes);
router.post('/ndr/notes', auth(), c.createNdrNote);
router.put('/ndr/notes/:id', auth(), c.updateNdrNote);
router.delete('/ndr/notes/:id', auth(), c.deleteNdrNote);


// ── Legacy aliases ────────────────────────────────────────────────────────────
router.post('/login', auth(), c.login);
router.get('/serviceability', auth(), c.checkServiceability);
router.post('/order/create', auth(), c.createOrder);
router.post('/awb/assign', auth(), c.assignAWB);
router.post('/pickup/generate', auth(), c.generatePickup);
router.post('/manifest/generate', auth(), c.generateManifest);
router.post('/manifest/print', auth(), c.printManifest);
router.post('/label/generate', auth(), c.generateLabel);
router.post('/invoice/print', auth(), c.printInvoice);
router.post('/track/:awb', auth(), c.trackByAWB);
router.post('/sync', auth(), c.syncShiprocket);
router.get('/pickup-locations', auth(), c.getPickupLocations);

export default router;

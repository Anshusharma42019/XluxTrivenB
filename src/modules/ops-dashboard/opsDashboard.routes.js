import express from 'express';
import auth from '../../middleware/auth.js';
import { cacheMiddleware } from '../../middleware/cache.js';
import * as c from './opsDashboard.controller.js';

const router = express.Router();

// Any authenticated user can read ops-dashboard data
const opsAuth = auth();
const cache = cacheMiddleware(120); // 2 minute cache for instant loads

router.get('/kpis',        opsAuth, cache, c.getKPIs);
router.get('/trend',       opsAuth, cache, c.getTrend);
router.get('/funnel',      opsAuth, cache, c.getFunnel);
router.get('/rto-reasons', opsAuth, cache, c.getRtoReasons);
router.get('/aging',       opsAuth, cache, c.getAging);
router.get('/leaderboard', opsAuth, cache, c.getLeaderboard);
router.get('/shipments',   opsAuth, cache, c.getShipments);
router.get('/alerts',      opsAuth, cache, c.getAlerts);

router.post('/rto-verification', opsAuth, c.submitRtoVerification);
router.post('/send-interakt-messages', opsAuth, c.sendInteraktMessages);

router.post('/invoice-history', opsAuth, c.createInvoiceHistory);
router.get('/invoice-history',  opsAuth, cache, c.getInvoiceHistory);

export default router;

import express from 'express';
import auth from '../../middleware/auth.js';
import { cacheMiddleware } from '../../middleware/cache.js';
import * as c from './opsDashboard.controller.js';

const router = express.Router();

// Any authenticated user can read ops-dashboard data
const opsAuth = auth();
// Real-time operational endpoints — no stale caching so changes reflect immediately
router.get('/kpis',        opsAuth, c.getKPIs);
router.get('/funnel',      opsAuth, c.getFunnel);
router.get('/shipments',   opsAuth, c.getShipments);
router.get('/trend',       opsAuth, c.getTrend);
router.get('/alerts',      opsAuth, c.getAlerts);
router.get('/staff-breakdown', opsAuth, cacheMiddleware(60), c.getStaffBreakdown);

// Analytical summaries
const cacheShort = cacheMiddleware(15);
router.get('/rto-reasons', opsAuth, cacheShort, c.getRtoReasons);
router.get('/aging',       opsAuth, cacheShort, c.getAging);
router.get('/leaderboard', opsAuth, cacheShort, c.getLeaderboard);

router.post('/rto-verification', opsAuth, c.submitRtoVerification);
router.post('/send-interakt-messages', opsAuth, c.sendInteraktMessages);

router.post('/invoice-history', opsAuth, c.createInvoiceHistory);
router.get('/invoice-history',  opsAuth, cacheShort, c.getInvoiceHistory);

export default router;

import express from 'express';
import auth from '../../middleware/auth.js';
import * as c from './opsDashboard.controller.js';

const router = express.Router();

// Any authenticated user can read ops-dashboard data
const opsAuth = auth();

router.get('/kpis',        opsAuth, c.getKPIs);
router.get('/trend',       opsAuth, c.getTrend);
router.get('/funnel',      opsAuth, c.getFunnel);
router.get('/rto-reasons', opsAuth, c.getRtoReasons);
router.get('/aging',       opsAuth, c.getAging);
router.get('/leaderboard', opsAuth, c.getLeaderboard);
router.get('/shipments',   opsAuth, c.getShipments);
router.get('/alerts',      opsAuth, c.getAlerts);

router.post('/rto-verification', opsAuth, c.submitRtoVerification);

export default router;

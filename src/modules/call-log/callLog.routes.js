import express from 'express';
import auth from '../../middleware/auth.js';
import * as callLogController from './callLog.controller.js';

const router = express.Router();

// 1. Sync endpoint called by the Android APK
router.post(
  '/sync',
  auth('admin', 'manager', 'sales', 'support', 'logistics', 'doctor', 'staff'),
  callLogController.sync
);

// 2. Telecalling Desk Stats & Leaderboard
router.get(
  '/stats',
  auth('admin', 'manager', 'sales', 'support', 'doctor', 'staff', 'logistics'),
  callLogController.getStats
);

// 3. Paginated Call Logs List
router.get(
  '/',
  auth('admin', 'manager', 'sales', 'support', 'doctor', 'staff', 'logistics'),
  callLogController.getLogs
);

// 4. Inbound Missed Calls Desk
router.get(
  '/missed',
  auth('admin', 'manager', 'sales', 'support', 'doctor', 'staff', 'logistics'),
  callLogController.getMissedCalls
);

// 5. Mark Missed Call as Resolved
router.patch(
  '/missed/:id/resolve',
  auth('admin', 'manager', 'sales', 'support'),
  callLogController.resolveMissed
);

// 6. Lead Specific Call History
router.get(
  '/lead/:phone',
  auth('admin', 'manager', 'sales', 'support', 'logistics', 'doctor', 'staff'),
  callLogController.getLeadHistory
);

export default router;


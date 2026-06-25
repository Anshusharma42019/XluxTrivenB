import express from 'express';
import auth from '../../middleware/auth.js';
import * as c from './commission.controller.js';

const router = express.Router();

// Settings (admin only)
router.get('/settings', auth(), c.getCommissionSettings);
router.put('/settings', auth('admin', 'superadmin'), c.updateCommissionSettings);

// Staff-wise summary
router.get('/reorder/staff-summary', auth('admin', 'superadmin'), c.getStaffCommissionSummary);
router.post('/reorder/staff/:staff_id/pay-all', auth('admin', 'superadmin'), c.markStaffCommissionsPaid);

// Reorder commissions
router.get('/reorder', auth(), c.getReorderCommissions);
router.patch('/reorder/:id/pay', auth('admin', 'superadmin'), c.markCommissionPaid);
router.post('/reorder/pay-all', auth('admin', 'superadmin'), c.markAllCommissionsPaid);

export default router;

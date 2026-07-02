import express from 'express';
import auth from '../../middleware/auth.js';
import * as c from './commission.controller.js';
import { generateReorderCommissions } from '../shiprocket/shiprocket.controller.js';

const router = express.Router();

// Admin routes (admin only)
router.get('/debug/count-commissions', async (req, res) => {
  const FollowupCommissionSettings = (await import('./followupCommissionSettings.model.js')).default;
  const ReorderCommission = (await import('./reorderCommission.model.js')).default;
  const count = await ReorderCommission.countDocuments();
  const smCount = await ReorderCommission.countDocuments({ order_model: 'ShipmaxxOrder' });
  const srCount = await ReorderCommission.countDocuments({ order_model: 'ShiprocketOrder' });
  const settingsCount = await FollowupCommissionSettings.countDocuments();
  res.json({ count, smCount, srCount, settingsCount });
});

router.get('/debug/clean', async (req, res) => {
  try {
    const ReorderCommission = (await import('./reorderCommission.model.js')).default;
    await ReorderCommission.deleteMany({});
    
    const Order = (await import('../shiprocket/models/order.model.js')).Order;
    const ShipmaxxOrder = (await import('../shipmaxx/models/shipmaxxOrder.model.js')).ShipmaxxOrder;
    
    await Order.updateMany(
      { status: { $in: ['DELIVERED', 'Delivered', 'delivered'] } },
      { $set: { reorder_commission_generated: false } }
    );
    await ShipmaxxOrder.updateMany(
      { status: { $in: ['DELIVERED', 'Delivered', 'delivered'] } },
      { $set: { reorder_commission_generated: false } }
    );
    
    const { generateReorderCommissions } = await import('../shiprocket/shiprocket.controller.js');
    const logs = await generateReorderCommissions();
    res.json({ message: 'Cleaned and regenerated', logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

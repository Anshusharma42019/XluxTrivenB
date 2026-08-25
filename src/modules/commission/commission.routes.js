import express from 'express';
import auth from '../../middleware/auth.js';
import * as c from './commission.controller.js';
import { generateReorderCommissions } from '../shiprocket/shiprocket.controller.js';

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// Debug / maintenance routes (admin-only, no auth middleware for convenience)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/debug/count-commissions', async (req, res) => {
  const FollowupCommissionSettings = (await import('./followupCommissionSettings.model.js')).default;
  const ReorderCommission = (await import('./reorderCommission.model.js')).default;
  const CommissionRecord  = (await import('./commissionRecord.model.js')).default;
  const OrderChain        = (await import('./orderChain.model.js')).default;
  const AuditLog          = (await import('./auditLog.model.js')).default;

  const [count, smCount, srCount, settingsCount, chainCount, recordCount, auditCount] = await Promise.all([
    ReorderCommission.countDocuments(),
    ReorderCommission.countDocuments({ order_model: 'ShipmaxxOrder' }),
    ReorderCommission.countDocuments({ order_model: 'ShiprocketOrder' }),
    FollowupCommissionSettings.countDocuments(),
    OrderChain.countDocuments(),
    CommissionRecord.countDocuments(),
    AuditLog.countDocuments(),
  ]);

  res.json({
    legacy: { total: count, shiprocket: srCount, shipmaxx: smCount },
    new:    { orderChainEntries: chainCount, commissionRecords: recordCount, auditLogs: auditCount },
    settingsCount,
  });
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
    res.json({ message: 'Cleaned and regenerated (legacy only — new system unaffected)', logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Settings
// ─────────────────────────────────────────────────────────────────────────────
router.get('/settings',  auth(),                         c.getCommissionSettings);
router.put('/settings',  auth('admin', 'superadmin'),    c.updateCommissionSettings);

// ─────────────────────────────────────────────────────────────────────────────
// Legacy ReorderCommission routes (kept for backward compatibility)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/reorder/staff-summary',          auth('admin', 'superadmin'),           c.getStaffCommissionSummary);
router.post('/reorder/staff/:staff_id/pay-all', auth('admin', 'superadmin'),         c.markStaffCommissionsPaid);
router.get('/reorder',                        auth(),                                c.getReorderCommissions);
router.patch('/reorder/:id/pay',              auth('admin', 'superadmin'),           c.markCommissionPaid);
router.post('/reorder/pay-all',               auth('admin', 'superadmin'),           c.markAllCommissionsPaid);

// ─────────────────────────────────────────────────────────────────────────────
// NEW: Immutable CommissionRecord ledger (v1.0+ system)
// ─────────────────────────────────────────────────────────────────────────────

// List commission records with full rule_version, entry_type, and reversal info
router.get('/records',   auth(),                         c.getCommissionRecords);

// Get staff-wise commission summary from CommissionRecord ledger
router.get('/records/staff-summary', auth('admin', 'superadmin'), c.getStaffCommissionRecordSummary);

// Create a reversal (correction) — inserts a new negative row, never edits history
router.post('/records/:id/reverse', auth('admin', 'superadmin'), c.reverseCommission);

// Mark all pending commission records of a staff as paid
router.post('/records/staff/:staff_id/pay-all', auth('admin', 'superadmin'), c.markStaffCommissionRecordsPaid);

// Mark a single commission record as paid
router.patch('/records/:id/pay', auth('admin', 'superadmin'), c.markCommissionRecordPaid);

// ─────────────────────────────────────────────────────────────────────────────
// NEW: Order chain (full customer order history with submitter details)
// ─────────────────────────────────────────────────────────────────────────────

// GET /commission/chain/:leadId  — full order chain for a customer
router.get('/chain/:leadId',           auth('admin', 'superadmin', 'manager'),       c.getCommissionChain);

// GET /commission/chain/:leadId/integrity  — verify SHA-256 hash linkage
router.get('/chain/:leadId/integrity', auth('admin', 'superadmin'),                  c.getChainIntegrity);

// ─────────────────────────────────────────────────────────────────────────────
// NEW: Audit trail
// ─────────────────────────────────────────────────────────────────────────────

// GET /commission/audit/:entityType/:entityId  — full audit log for any entity
router.get('/audit/:entityType/:entityId', auth('admin', 'superadmin'),              c.getEntityAuditTrail);

export default router;

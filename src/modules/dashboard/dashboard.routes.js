import express from 'express';
import auth from '../../middleware/auth.js';
import departmentFilter from '../../middleware/departmentFilter.js';
import dashboardController from './dashboard.controller.js';
import catchAsync from '../../utils/catchAsync.js';
import { cacheMiddleware } from '../../middleware/cache.js';
import { cache } from '../../utils/cache.js';

const router = express.Router();

router.get('/debug', dashboardController.debugDeliveries);
router.get('/stats', auth('admin', 'manager', 'sales', 'support', 'logistics'), departmentFilter, cacheMiddleware(300), dashboardController.getStats);
router.get('/revenue-chart', auth('admin', 'manager'), departmentFilter, cacheMiddleware(300), dashboardController.getRevenueChart);
router.get('/staff-stats', auth('admin', 'manager', 'sales', 'support', 'logistics'), departmentFilter, cacheMiddleware(300), dashboardController.getStaffStats);
router.post('/staff-target', auth('admin', 'manager', 'sales', 'support', 'logistics'), dashboardController.setStaffTarget);
router.get('/target-history', auth('admin', 'manager', 'sales', 'support', 'logistics'), cacheMiddleware(300), dashboardController.getTargetHistory);
router.get('/staff-verifications', auth('admin', 'manager', 'sales', 'support', 'logistics'), departmentFilter, cacheMiddleware(300), dashboardController.getStaffVerifications);
router.get('/staff-today-lists', auth('admin', 'manager', 'sales', 'support', 'logistics'), departmentFilter, cacheMiddleware(300), dashboardController.getStaffTodayLists);
router.get('/staff-monthly-chart', auth('admin', 'manager', 'sales', 'support', 'logistics'), departmentFilter, cacheMiddleware(300), dashboardController.getStaffMonthlyChart);
router.get('/all-staff-stats', auth('admin', 'manager'), departmentFilter, cacheMiddleware(300), dashboardController.getAllStaffStats);
router.get('/staff-commission', auth('admin', 'manager', 'sales', 'support', 'logistics'), cacheMiddleware(300), dashboardController.getStaffCommission);
router.get('/all-staff-commissions', auth('admin', 'manager'), cacheMiddleware(300), dashboardController.getAllStaffCommissions);
router.post('/save-commission-override', auth('admin', 'manager'), dashboardController.saveCommissionOverride);
router.get('/unassigned-orders', auth('admin', 'manager'), cacheMiddleware(300), dashboardController.getUnassignedOrders);
router.post('/assign-order', auth('admin', 'manager'), dashboardController.assignOrder);

router.get('/cache-stats', auth('admin', 'manager'), (req, res) => {
  const memory = process.memoryUsage();
  res.json({
    status: 200,
    data: {
      cacheSize: cache.cache.size,
      maxSize: cache.maxSize,
      keys: Array.from(cache.cache.keys()),
      memoryUsage: {
        rss: `${(memory.rss / 1024 / 1024).toFixed(2)} MB`,
        heapTotal: `${(memory.heapTotal / 1024 / 1024).toFixed(2)} MB`,
        heapUsed: `${(memory.heapUsed / 1024 / 1024).toFixed(2)} MB`,
        external: `${(memory.external / 1024 / 1024).toFixed(2)} MB`,
        arrayBuffers: memory.arrayBuffers ? `${(memory.arrayBuffers / 1024 / 1024).toFixed(2)} MB` : 'N/A'
      }
    }
  });
});

export default router;

import express from 'express';
import auth from '../../middleware/auth.js';
import departmentFilter from '../../middleware/departmentFilter.js';
import dashboardController from './dashboard.controller.js';
import catchAsync from '../../utils/catchAsync.js';

const router = express.Router();

router.get('/stats', auth('admin', 'manager', 'sales', 'support', 'logistics'), departmentFilter, dashboardController.getStats);
router.get('/revenue-chart', auth('admin', 'manager'), departmentFilter, dashboardController.getRevenueChart);
router.get('/staff-stats', auth('admin', 'manager', 'sales', 'support', 'logistics'), departmentFilter, dashboardController.getStaffStats);
router.post('/staff-target', auth('admin', 'manager', 'sales', 'support', 'logistics'), dashboardController.setStaffTarget);
router.get('/target-history', auth('admin', 'manager', 'sales', 'support', 'logistics'), dashboardController.getTargetHistory);
router.get('/staff-verifications', auth('admin', 'manager', 'sales', 'support', 'logistics'), departmentFilter, dashboardController.getStaffVerifications);
router.get('/staff-today-lists', auth('admin', 'manager', 'sales', 'support', 'logistics'), departmentFilter, dashboardController.getStaffTodayLists);
router.get('/staff-monthly-chart', auth('admin', 'manager', 'sales', 'support', 'logistics'), departmentFilter, dashboardController.getStaffMonthlyChart);
router.get('/all-staff-stats', auth('admin', 'manager'), departmentFilter, dashboardController.getAllStaffStats);
router.get('/staff-commission', auth('admin', 'manager', 'sales', 'support', 'logistics'), dashboardController.getStaffCommission);
router.get('/all-staff-commissions', auth('admin', 'manager'), dashboardController.getAllStaffCommissions);
router.post('/save-commission-override', auth('admin', 'manager'), dashboardController.saveCommissionOverride);

export default router;

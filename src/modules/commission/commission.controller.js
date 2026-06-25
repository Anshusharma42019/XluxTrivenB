import catchAsync from '../../utils/catchAsync.js';
import ApiResponse from '../../utils/ApiResponse.js';
import FollowupCommissionSettings from './followupCommissionSettings.model.js';
import ReorderCommission from './reorderCommission.model.js';
import User from '../user/user.model.js';

// ── Admin: Get commission settings ───────────────────────────────────────────
export const getCommissionSettings = catchAsync(async (req, res) => {
  let settings = await FollowupCommissionSettings.findOne().sort({ createdAt: -1 }).lean();
  if (!settings) {
    settings = { reorder_commission_amount: 0, reorder_commission_percent: 0, commission_type: 'flat', is_active: true };
  }
  res.json(new ApiResponse(200, settings, 'Commission settings fetched'));
});

// ── Admin: Update commission settings ────────────────────────────────────────
export const updateCommissionSettings = catchAsync(async (req, res) => {
  const { reorder_commission_amount, reorder_commission_percent, original_staff_commission_amount,
    original_staff_commission_percent, commission_type, is_active, price_slabs } = req.body;
  let settings = await FollowupCommissionSettings.findOne().sort({ createdAt: -1 });
  if (!settings) settings = new FollowupCommissionSettings({});
  if (commission_type) settings.commission_type = commission_type;
  if (reorder_commission_amount !== undefined) settings.reorder_commission_amount = Number(reorder_commission_amount);
  if (reorder_commission_percent !== undefined) settings.reorder_commission_percent = Number(reorder_commission_percent);
  if (original_staff_commission_amount !== undefined) settings.original_staff_commission_amount = Number(original_staff_commission_amount);
  if (original_staff_commission_percent !== undefined) settings.original_staff_commission_percent = Number(original_staff_commission_percent);
  if (Array.isArray(price_slabs)) settings.price_slabs = price_slabs;
  if (is_active !== undefined) settings.is_active = is_active;
  settings.updated_by = req.user._id;
  await settings.save();
  res.json(new ApiResponse(200, settings, 'Commission settings updated'));
});

// ── Get reorder commissions (admin: all, staff: own) ─────────────────────────
export const getReorderCommissions = catchAsync(async (req, res) => {
  const { page = 1, per_page = 20, staff_id, month, year, status } = req.query;
  const isAdmin = ['admin', 'superadmin'].includes(req.user.role);

  const match = {};
  if (!isAdmin) match.staff_id = req.user._id;
  else if (staff_id) match.staff_id = staff_id;
  if (status) match.status = status;
  if (month !== undefined) match.month = Number(month);
  if (year !== undefined) match.year = Number(year);

  const skip = (Number(page) - 1) * Number(per_page);
  const [data, total] = await Promise.all([
    ReorderCommission.find(match)
      .populate('staff_id', 'name role')
      .populate('order_id', 'order_id billing_customer_name sub_total delivered_at status')
      .populate('source_order_id', 'order_id billing_customer_name')
      .populate('lead_id', 'name phone')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(per_page))
      .lean(),
    ReorderCommission.countDocuments(match),
  ]);

  // Summary totals
  const summary = await ReorderCommission.aggregate([
    { $match: match },
    { $group: { _id: null, total_amount: { $sum: '$commission_amount' }, pending: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, '$commission_amount', 0] } }, paid: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, '$commission_amount', 0] } } } },
  ]);

  res.json(new ApiResponse(200, {
    data,
    total,
    page: Number(page),
    per_page: Number(per_page),
    summary: summary[0] || { total_amount: 0, pending: 0, paid: 0 },
  }, 'Reorder commissions fetched'));
});

// ── Admin: Staff-wise commission summary ─────────────────────────────────────
export const getStaffCommissionSummary = catchAsync(async (req, res) => {
  const { month, year } = req.query;
  const isAdmin = ['admin', 'superadmin', 'manager'].includes(req.user.role);
  const match = {};
  if (!isAdmin) match.staff_id = req.user._id;
  if (month !== undefined && month !== '') match.month = Number(month);
  if (year !== undefined && year !== '') match.year = Number(year);

  // Get all commission rows grouped by staff
  const commissionRows = await ReorderCommission.aggregate([
    { $match: match },
    { $group: {
      _id: '$staff_id',
      total_amount:   { $sum: '$commission_amount' },
      pending_amount: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, '$commission_amount', 0] } },
      paid_amount:    { $sum: { $cond: [{ $eq: ['$status', 'paid'] },    '$commission_amount', 0] } },
      total_orders:   { $sum: 1 },
      original_count: { $sum: { $cond: [{ $eq: ['$commission_role', 'original'] }, 1, 0] } },
      reorder_count:  { $sum: { $cond: [{ $eq: ['$commission_role', 'reorder'] },  1, 0] } },
    }},
  ]);

  // Build a map for quick lookup
  const commMap = {};
  for (const r of commissionRows) commMap[String(r._id)] = r;

  // Fetch ALL active sales/staff users
  const users = await User.find({ isDeleted: { $ne: true }, role: { $in: ['sales', 'staff', 'manager'] } })
    .select('name role').lean();

  // Merge — users with no commission get zeros
  const rows = users.map(u => {
    const c = commMap[String(u._id)] || {};
    return {
      staff_id:       u._id,
      name:           u.name,
      role:           u.role,
      total_amount:   c.total_amount   || 0,
      pending_amount: c.pending_amount || 0,
      paid_amount:    c.paid_amount    || 0,
      total_orders:   c.total_orders   || 0,
      original_count: c.original_count || 0,
      reorder_count:  c.reorder_count  || 0,
    };
  }).sort((a, b) => b.total_amount - a.total_amount);

  res.json(new ApiResponse(200, rows, 'Staff commission summary fetched'));
});

// ── Admin: Mark all pending of one staff as paid ──────────────────────────────
export const markStaffCommissionsPaid = catchAsync(async (req, res) => {
  const { staff_id } = req.params;
  const { month, year } = req.body;
  const match = { status: 'pending', staff_id };
  if (month !== undefined) match.month = Number(month);
  if (year !== undefined) match.year = Number(year);
  const result = await ReorderCommission.updateMany(match, { status: 'paid', paid_at: new Date(), paid_by: req.user._id });
  res.json(new ApiResponse(200, { modifiedCount: result.modifiedCount }, `${result.modifiedCount} commissions paid`));
});

// ── Admin: Mark commission as paid ───────────────────────────────────────────
export const markCommissionPaid = catchAsync(async (req, res) => {
  const { id } = req.params;
  const commission = await ReorderCommission.findByIdAndUpdate(
    id,
    { status: 'paid', paid_at: new Date(), paid_by: req.user._id },
    { new: true }
  ).populate('staff_id', 'name role');
  if (!commission) return res.status(404).json(new ApiResponse(404, null, 'Commission not found'));
  res.json(new ApiResponse(200, commission, 'Commission marked as paid'));
});

// ── Admin: Mark all pending commissions of a staff as paid ───────────────────
export const markAllCommissionsPaid = catchAsync(async (req, res) => {
  const { staff_id, month, year } = req.body;
  const match = { status: 'pending' };
  if (staff_id) match.staff_id = staff_id;
  if (month !== undefined) match.month = Number(month);
  if (year !== undefined) match.year = Number(year);

  const result = await ReorderCommission.updateMany(match, {
    status: 'paid', paid_at: new Date(), paid_by: req.user._id,
  });
  res.json(new ApiResponse(200, { modifiedCount: result.modifiedCount }, `${result.modifiedCount} commissions marked as paid`));
});

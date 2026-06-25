import express from 'express';
import auth from '../../middleware/auth.js';
import departmentFilter from '../../middleware/departmentFilter.js';
import ReadyToShipment from './readytoshipment.model.js';
import Task from '../task/task.model.js';

const router = express.Router();

// Stats — pincode & state wise aggregation of ready-to-ship orders
// Supports drill-down via ?filterState=<state> or ?filterPincode=<pincode>
router.get('/stats', auth('admin', 'manager', 'sales', 'logistics'), departmentFilter, async (req, res) => {
  try {
    const taskQuery = { status: 'ready_to_shipment', isDeleted: false };
    if (['sales', 'support', 'logistics'].includes(req.user.role)) {
      if (req.userDepartments && req.userDepartments.length > 0) {
        taskQuery.department = { $in: req.userDepartments };
      }
    } else if (req.query.department) {
      taskQuery.department = req.query.department;
    }
    const validTaskIds = await Task.distinct('_id', taskQuery);

    const { filterState, filterPincode, filterMonth } = req.query;

    // Drill-down extra filter (state or pincode)
    const drillFilter = {};
    if (filterState) drillFilter.state = { $regex: new RegExp(`^${filterState}$`, 'i') };
    if (filterPincode) drillFilter.pincode = filterPincode;

    // Month filter for state/pincode column: filterMonth = 'YYYY-MM'
    const monthFilter = {};
    if (filterMonth && /^\d{4}-\d{2}$/.test(filterMonth)) {
      const [yr, mo] = filterMonth.split('-').map(Number);
      monthFilter.createdAt = { $gte: new Date(yr, mo - 1, 1), $lt: new Date(yr, mo, 1) };
    }

    const allMatch        = { task: { $in: validTaskIds }, ...drillFilter, ...monthFilter };
    const baseMatch       = { sentToShiprocket: { $ne: true }, task: { $in: validTaskIds }, ...monthFilter };
    const drillBase       = { sentToShiprocket: { $ne: true }, task: { $in: validTaskIds }, ...drillFilter, ...monthFilter };
    const stateMatch      = baseMatch;
    const drillStateMatch = drillBase;

    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 11);
    twelveMonthsAgo.setDate(1);
    twelveMonthsAgo.setHours(0, 0, 0, 0);

    const eightWeeksAgo = new Date();
    eightWeeksAgo.setDate(eightWeeksAgo.getDate() - 56);
    eightWeeksAgo.setHours(0, 0, 0, 0);

    // Always fetch all months for the dropdown (unfiltered by month)
    const allMonthsAgg = filterMonth ? ReadyToShipment.aggregate([
      { $match: { task: { $in: validTaskIds }, ...drillFilter, createdAt: { $gte: twelveMonthsAgo } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$createdAt', timezone: 'Asia/Kolkata' } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
      { $project: { month: '$_id', count: 1, _id: 0 } },
    ]) : Promise.resolve(null);

    const [byPincode, byState, byMonth, byWeek, total, drillTotal, allMonths] = await Promise.all([
      // Pincodes — if state is filtered, show pincodes for that state; else top-20 overall
      ReadyToShipment.aggregate([
        { $match: filterState ? drillStateMatch : stateMatch },
        { $group: { _id: '$pincode', count: { $sum: 1 }, states: { $addToSet: '$state' } } },
        { $match: { _id: { $ne: null, $ne: '' } } },
        { $sort: { count: -1 } },
        { $limit: 30 },
        { $project: { pincode: '$_id', count: 1, states: 1, _id: 0 } },
      ]),
      // States — filtered by month if provided
      ReadyToShipment.aggregate([
        { $match: stateMatch },
        { $group: { _id: '$state', count: { $sum: 1 }, pincodes: { $addToSet: '$pincode' } } },
        { $match: { _id: { $ne: null, $ne: '' } } },
        { $sort: { count: -1 } },
        { $project: { state: '$_id', count: 1, pincodes: 1, _id: 0 } },
      ]),
      // Monthly — filtered if drill-down or month active
      ReadyToShipment.aggregate([
        { $match: filterMonth ? allMatch : { ...allMatch, createdAt: { $gte: twelveMonthsAgo } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m', date: '$createdAt', timezone: 'Asia/Kolkata' } },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
        { $project: { month: '$_id', count: 1, _id: 0 } },
      ]),
      // Weekly — day-wise when month filtered, else ISO-week grouped
      ReadyToShipment.aggregate(
        filterMonth
          ? [
              { $match: allMatch },
              {
                $group: {
                  _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'Asia/Kolkata' } },
                  count: { $sum: 1 },
                  weekStart: { $min: '$createdAt' },
                },
              },
              { $sort: { _id: 1 } },
              { $project: { week: '$_id', count: 1, weekStart: 1, _id: 0 } },
            ]
          : [
              { $match: { ...allMatch, createdAt: { $gte: eightWeeksAgo } } },
              {
                $group: {
                  _id: {
                    year: { $isoWeekYear: '$createdAt' },
                    week: { $isoWeek: '$createdAt' },
                  },
                  count: { $sum: 1 },
                  weekStart: { $min: '$createdAt' },
                },
              },
              { $sort: { '_id.year': 1, '_id.week': 1 } },
              {
                $project: {
                  week: { $concat: [{ $toString: '$_id.year' }, '-W', { $toString: '$_id.week' }] },
                  count: 1,
                  weekStart: 1,
                  _id: 0,
                },
              },
            ]
      ),
      // Overall pending count (no drill filter)
      ReadyToShipment.countDocuments(baseMatch),
      // Drill-down pending count (with filter)
      (filterState || filterPincode) ? ReadyToShipment.countDocuments(drillBase) : Promise.resolve(null),
      allMonthsAgg,
    ]);

    res.json({
      status: 200,
      data: {
        byPincode, byState, byMonth, byWeek, total,
        drillTotal: drillTotal ?? total,
        filterState: filterState || null,
        filterPincode: filterPincode || null,
        filterMonth: filterMonth || null,
        allMonths: allMonths || null,
      },
    });
  } catch (e) {
    res.status(500).json({ status: 500, message: e.message });
  }
});

// Fast fetch — filter at DB level, no JS filtering
router.get('/', auth('admin', 'manager', 'sales', 'logistics'), departmentFilter, async (req, res) => {
  try {
    const taskQuery = { status: 'ready_to_shipment', isDeleted: false };
    if (['sales', 'support', 'logistics'].includes(req.user.role)) {
      if (req.userDepartments && req.userDepartments.length > 0) {
        taskQuery.department = { $in: req.userDepartments };
      }
    } else if (req.query.department) {
      taskQuery.department = req.query.department;
    }
    const validTaskIds = await Task.distinct('_id', taskQuery);

    const records = await ReadyToShipment.find({
      sentToShiprocket: { $ne: true },
      task: { $in: validTaskIds },
    })
      .populate('assignedTo', 'name email')
      .populate('lead', 'name phone status')
      .populate('task', 'department')
      .sort({ createdAt: -1 })
      .lean();

    res.json({ status: 200, data: records });
  } catch (e) {
    res.status(500).json({ status: 500, message: e.message });
  }
});

// Manual sync — only called when user clicks "Sync Verified"
router.post('/sync', auth('admin', 'manager', 'sales', 'logistics'), departmentFilter, async (req, res) => {
  try {
    const Verification = (await import('../verification/verification.model.js')).default;

    const taskQuery = { status: 'ready_to_shipment', isDeleted: false };
    if (['sales', 'support', 'logistics'].includes(req.user.role)) {
      if (req.userDepartments && req.userDepartments.length > 0) {
        taskQuery.department = { $in: req.userDepartments };
      }
    } else if (req.query.department) {
      taskQuery.department = req.query.department;
    }

    const [verifiedStuck, tasks] = await Promise.all([
      Verification.find({ status: 'verified' }).populate('assignedTo', 'name email').populate('lead', 'name phone status createdBy assignedTo pending_reorder_source'),
      Task.find(taskQuery).populate('assignedTo', 'name email').populate('lead', 'name phone status'),
    ]);

    await Promise.all([
      ...verifiedStuck.filter(v => v.task).map(v => {
        let rtsAssignedTo = v.assignedTo?._id || v.assignedTo;
        return Promise.all([
          Task.findByIdAndUpdate(v.task, { status: 'ready_to_shipment', assignedTo: rtsAssignedTo }),
          ReadyToShipment.findOneAndUpdate(
            { task: v.task },
            { $set: { title: v.title, assignedTo: rtsAssignedTo, lead: v.lead?._id || v.lead, description: v.description, problem: v.problem, age: v.age, weight: v.weight, height: v.height, otherProblems: v.otherProblems, problemDuration: v.problemDuration, price: v.price, cityVillageType: v.cityVillageType, cityVillage: v.cityVillage, houseNo: v.houseNo, postOffice: v.postOffice, district: v.district, landmark: v.landmark, pincode: v.pincode, state: v.state, reminderAt: v.reminderAt }, $setOnInsert: { task: v.task } },
            { upsert: true }
          ),
        ]);
      }),
      ...tasks.map(task =>
        ReadyToShipment.findOneAndUpdate(
          { task: task._id },
          { $set: { title: task.title, assignedTo: task.assignedTo?._id, lead: task.lead?._id, description: task.description, problem: task.problem, age: task.age, weight: task.weight, height: task.height, otherProblems: task.otherProblems, problemDuration: task.problemDuration, price: task.price, cityVillageType: task.cityVillageType, cityVillage: task.cityVillage, houseNo: task.houseNo, postOffice: task.postOffice, district: task.district, landmark: task.landmark, pincode: task.pincode, state: task.state, reminderAt: task.reminderAt, notes: task.notes }, $setOnInsert: { task: task._id } },
          { upsert: true }
        )
      ),
    ]);

    const records = await ReadyToShipment.find({ sentToShiprocket: { $ne: true } })
      .populate('assignedTo', 'name email')
      .populate('lead', 'name phone status')
      .populate('task', 'status isDeleted department')
      .sort({ createdAt: -1 })
      .lean();

    const filtered = records.filter(r => r.task && r.task.status === 'ready_to_shipment' && !r.task.isDeleted);
    res.json({ status: 200, data: filtered });
  } catch (e) {
    res.status(500).json({ status: 500, message: e.message });
  }
});

router.get('/for-shipment', auth('admin', 'manager', 'sales', 'logistics'), async (req, res) => {
  try {
    const records = await ReadyToShipment.find({ sentToShiprocket: { $ne: true } })
      .populate('lead', 'name phone email address')
      .populate('task', 'status isDeleted title')
      .sort({ createdAt: -1 });
    const filtered = records.filter(r => r.task && r.task.status === 'ready_to_shipment' && !r.task.isDeleted);
    res.json({ status: 200, data: filtered });
  } catch (e) {
    res.status(500).json({ status: 500, message: e.message });
  }
});

router.get('/by-user/:userId', auth('admin', 'manager'), async (req, res) => {
  try {
    const records = await Task.find({
      status: 'ready_to_shipment',
      isDeleted: false,
      assignedTo: req.params.userId,
    })
      .populate('assignedTo', 'name email')
      .populate('lead', 'name phone')
      .sort({ createdAt: -1 });
    res.json({ status: 200, data: records });
  } catch (e) {
    res.status(500).json({ status: 500, message: e.message });
  }
});

router.patch('/:id/sent', auth('admin', 'manager', 'sales', 'logistics'), async (req, res) => {
  try {
    await ReadyToShipment.findByIdAndUpdate(req.params.id, { sentToShiprocket: true });
    res.json({ status: 200, message: 'Marked as sent' });
  } catch (e) {
    res.status(500).json({ status: 500, message: e.message });
  }
});

router.delete('/:id', auth('admin', 'manager'), async (req, res) => {
  try {
    const record = await ReadyToShipment.findByIdAndDelete(req.params.id);
    if (!record) return res.status(404).json({ status: 404, message: 'Not found' });
    await Task.findByIdAndUpdate(record.task, { status: 'cancelled' });
    res.json({ status: 200, message: 'Deleted' });
  } catch (e) {
    res.status(500).json({ status: 500, message: e.message });
  }
});

export default router;

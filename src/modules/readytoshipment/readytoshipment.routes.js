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
    
    if (req.query.department) {
      taskQuery.department = req.query.department;
      if (['sales', 'support', 'logistics'].includes(req.user.role) && req.userDepartments?.length > 0) {
        if (!req.userDepartments.includes(req.query.department)) taskQuery.department = "NOT_ALLOWED";
      }
    } else if (['sales', 'support', 'logistics'].includes(req.user.role) && req.userDepartments?.length > 0) {
      taskQuery.department = { $in: req.userDepartments };
    }
    const validTaskIds = await Task.distinct('_id', taskQuery);

    const { filterState, filterPincode, filterMonth } = req.query;

    // Drill-down extra filter (state or pincode)
    const drillFilter = {};
    if (filterState) {
      if (filterState === 'Not Specified' || filterState === 'Unspecified') {
        drillFilter.$or = [{ state: null }, { state: '' }, { state: { $exists: false } }, { state: { $regex: /^\s*$/ } }];
      } else {
        drillFilter.state = { $regex: new RegExp(`^\\s*${filterState.trim()}\\s*$`, 'i') };
      }
    }
    if (filterPincode) {
      if (filterPincode === 'Not Specified' || filterPincode === 'Unspecified') {
        drillFilter.$or = [{ pincode: null }, { pincode: '' }, { pincode: { $exists: false } }, { pincode: { $regex: /^\s*$/ } }];
      } else {
        drillFilter.pincode = { $regex: new RegExp(`^\\s*${filterPincode.trim()}\\s*$`, 'i') };
      }
    }

    // Month filter for state/pincode column: filterMonth = 'YYYY-MM'
    const monthFilter = {};
    if (filterMonth && /^\d{4}-\d{2}$/.test(filterMonth)) {
      const [yr, mo] = filterMonth.split('-').map(Number);
      monthFilter.createdAt = { $gte: new Date(yr, mo - 1, 1), $lt: new Date(yr, mo, 1) };
    }

    const allMatch        = { task: { $in: validTaskIds }, ...drillFilter, ...monthFilter };
    const baseMatch       = { sentToShiprocket: { $ne: true }, task: { $in: validTaskIds }, ...monthFilter };
    const drillBase       = { sentToShiprocket: { $ne: true }, task: { $in: validTaskIds }, ...drillFilter, ...monthFilter };
    const stateMatch      = { task: { $in: validTaskIds }, ...monthFilter };
    const drillStateMatch = { task: { $in: validTaskIds }, ...drillFilter, ...monthFilter };

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

    const [rawPincodes, rawStates, byMonth, byWeek, total, drillTotal, allMonths] = await Promise.all([
      // Pincodes — show all pincodes without limit, grouping cleanly
      ReadyToShipment.aggregate([
        { $match: filterState ? drillStateMatch : stateMatch },
        {
          $group: {
            _id: { $toUpper: { $trim: { input: { $ifNull: ['$pincode', ''] } } } },
            count: { $sum: 1 },
            states: { $addToSet: { $toUpper: { $trim: { input: { $ifNull: ['$state', ''] } } } } },
          },
        },
        { $sort: { count: -1 } },
      ]),
      // States — filtered by month or pincode drill-down, normalized uppercase grouping
      ReadyToShipment.aggregate([
        { $match: filterPincode ? drillStateMatch : stateMatch },
        {
          $group: {
            _id: { $toUpper: { $trim: { input: { $ifNull: ['$state', ''] } } } },
            count: { $sum: 1 },
            pincodes: { $addToSet: { $toUpper: { $trim: { input: { $ifNull: ['$pincode', ''] } } } } },
          },
        },
        { $sort: { count: -1 } },
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

    const formatStateName = (str) => {
      if (!str || !str.trim()) return 'Not Specified';
      const clean = str.trim().toLowerCase();
      return clean.replace(/\b\w/g, (m) => m.toUpperCase());
    };

    const stateMap = new Map();
    for (const item of rawStates) {
      const stateName = formatStateName(item._id);
      const pins = (item.pincodes || []).filter(p => p && p.trim() !== '');
      if (!stateMap.has(stateName)) {
        stateMap.set(stateName, { state: stateName, count: 0, pincodeSet: new Set() });
      }
      const entry = stateMap.get(stateName);
      entry.count += item.count;
      pins.forEach(p => entry.pincodeSet.add(p));
    }
    const byState = Array.from(stateMap.values()).map(e => ({
      state: e.state,
      count: e.count,
      pincodes: Array.from(e.pincodeSet),
    })).sort((a, b) => b.count - a.count);

    const pincodeMap = new Map();
    for (const item of rawPincodes) {
      const pin = (!item._id || !item._id.trim()) ? 'Not Specified' : item._id.trim();
      const stList = (item.states || []).filter(s => s && s.trim() !== '').map(s => formatStateName(s));
      if (!pincodeMap.has(pin)) {
        pincodeMap.set(pin, { pincode: pin, count: 0, stateSet: new Set() });
      }
      const entry = pincodeMap.get(pin);
      entry.count += item.count;
      stList.forEach(s => entry.stateSet.add(s));
    }
    const byPincode = Array.from(pincodeMap.values()).map(e => ({
      pincode: e.pincode,
      count: e.count,
      states: Array.from(e.stateSet),
    })).sort((a, b) => b.count - a.count);

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
    const { dayFilter, customDate, typeFilter, search } = req.query;

    const taskQuery = { status: 'ready_to_shipment', isDeleted: false };

    if (req.query.department) {
      taskQuery.department = req.query.department;
      if (['sales', 'support', 'logistics'].includes(req.user.role) && req.userDepartments?.length > 0) {
        if (!req.userDepartments.includes(req.query.department)) taskQuery.department = "NOT_ALLOWED";
      }
    } else if (['sales', 'support', 'logistics'].includes(req.user.role) && req.userDepartments?.length > 0) {
      taskQuery.department = { $in: req.userDepartments };
    }
    const validTaskIds = await Task.distinct('_id', taskQuery);

    const getISTDateStr = (offsetDays = 0) => {
      const d = new Date();
      d.setDate(d.getDate() + offsetDays);
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
      const y = parts.find(p => p.type === 'year').value;
      const m = parts.find(p => p.type === 'month').value;
      const day = parts.find(p => p.type === 'day').value;
      return `${y}-${m}-${day}`;
    };

    // Apply date range filters based on ReadyToShipment sync date OR Verification date
    let verifiedTaskIds = null;
    if (dayFilter === 'today' || dayFilter === 'yesterday' || (dayFilter === 'custom' && customDate)) {
      let start, end;
      if (dayFilter === 'today') {
        const dateStr = getISTDateStr(0);
        start = new Date(`${dateStr}T00:00:00.000+05:30`);
        end = new Date(`${dateStr}T23:59:59.999+05:30`);
      } else if (dayFilter === 'yesterday') {
        const dateStr = getISTDateStr(-1);
        start = new Date(`${dateStr}T00:00:00.000+05:30`);
        end = new Date(`${dateStr}T23:59:59.999+05:30`);
      } else if (dayFilter === 'custom' && customDate) {
        start = new Date(`${customDate}T00:00:00.000+05:30`);
        end = new Date(`${customDate}T23:59:59.999+05:30`);
      }

      if (start && end) {
        const Verification = (await import('../verification/verification.model.js')).default;
        verifiedTaskIds = await Verification.distinct('task', {
          updatedAt: { $gte: start, $lte: end }
        });
      }
    }

    // Intersect the valid tasks with verified tasks if a date filter was applied
    let finalTaskIds = validTaskIds;
    if (verifiedTaskIds) {
      const validSet = new Set(validTaskIds.map(id => id.toString()));
      finalTaskIds = verifiedTaskIds.filter(id => validSet.has(id.toString()));
    }

    const rtsQuery = { sentToShiprocket: { $ne: true }, task: { $in: finalTaskIds } };

    // Apply lead type and search keyword filter matching lead details
    let matchLeadIds = null;
    
    // Fix: User explicitly requested "All Types" to actually show all types, even for 'today'.
    const shouldExcludeOld = false;
    
    if (typeFilter && typeFilter !== 'all' || search) {
      const Lead = (await import('../lead/lead.model.js')).default;
      // We no longer filter by isDeleted: { $ne: true } because it hides active RTS tasks whose Lead was merged/deleted!
      const leadSubQuery = {};

      if (typeFilter === 'new') {
        leadSubQuery.status = { $ne: 'old' };
        leadSubQuery.pending_reorder_source = { $in: [null, undefined] };
      } else if (typeFilter === 'old') {
        leadSubQuery.$or = [
          { status: 'old' },
          { pending_reorder_source: { $exists: true, $ne: null } }
        ];
      }

      if (search) {
        leadSubQuery.$or = [
          { name: { $regex: search, $options: 'i' } },
          { phone: { $regex: search, $options: 'i' } }
        ];
      }

      matchLeadIds = await Lead.distinct('_id', leadSubQuery);
    }

    if (search) {
      const User = (await import('../user/user.model.js')).default;
      const matchUserIds = await User.distinct('_id', { name: { $regex: search, $options: 'i' } });

      const searchConditions = [
        { title: { $regex: search, $options: 'i' } },
        { state: { $regex: search, $options: 'i' } },
        { district: { $regex: search, $options: 'i' } },
        { assignedTo: { $in: matchUserIds } }
      ];

      if (matchLeadIds) {
        searchConditions.push({ lead: { $in: matchLeadIds } });
      }

      const searchClause = (typeFilter && typeFilter !== 'all') 
        ? { $and: [{ lead: { $in: matchLeadIds } }, { $or: searchConditions }] } 
        : { $or: searchConditions };

      if (rtsQuery.$or || rtsQuery.$and) {
        if (!rtsQuery.$and) rtsQuery.$and = [];
        if (rtsQuery.$or) {
          rtsQuery.$and.push({ $or: rtsQuery.$or });
          delete rtsQuery.$or;
        }
        rtsQuery.$and.push(searchClause);
      } else {
        Object.assign(rtsQuery, searchClause);
      }
    } else if (matchLeadIds) {
      rtsQuery.lead = { $in: matchLeadIds };
    }

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, parseInt(req.query.limit) || 15);
    const skip = (page - 1) * limit;

    // console.log('[DEBUG GET /]', req.query, 'rtsQuery:', JSON.stringify(rtsQuery));

    const [records, total] = await Promise.all([
      ReadyToShipment.find(rtsQuery)
        .populate('assignedTo', 'name email')
        .populate({
          path: 'lead',
          select: 'name phone status pending_reorder_source'
        })
        .populate('task', 'department')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      ReadyToShipment.countDocuments(rtsQuery)
    ]);

    res.json({
      status: 200,
      data: {
        records,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (e) {
    res.status(500).json({ status: 500, message: e.message });
  }
});

// Manual sync — only called when user clicks "Sync Verified"
router.post('/sync', auth('admin', 'manager', 'sales', 'logistics'), departmentFilter, async (req, res) => {
  try {
    const Verification = (await import('../verification/verification.model.js')).default;

    const taskQuery = { status: 'ready_to_shipment', isDeleted: false };
    if (req.query.department) {
      taskQuery.department = req.query.department;
      if (['sales', 'support', 'logistics'].includes(req.user.role) && req.userDepartments?.length > 0) {
        if (!req.userDepartments.includes(req.query.department)) taskQuery.department = "NOT_ALLOWED";
      }
    } else if (['sales', 'support', 'logistics'].includes(req.user.role) && req.userDepartments?.length > 0) {
      taskQuery.department = { $in: req.userDepartments };
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
    const record = await ReadyToShipment.findByIdAndUpdate(req.params.id, { $set: { isArchived: true, isDeleted: true } });
    if (!record) return res.status(404).json({ status: 404, message: 'Not found' });
    await Task.findByIdAndUpdate(record.task, { status: 'cancelled' });
    res.json({ status: 200, message: 'Deleted' });
  } catch (e) {
    res.status(500).json({ status: 500, message: e.message });
  }
});

export default router;

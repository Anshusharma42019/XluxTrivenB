import express from 'express';
import mongoose from 'mongoose';
import auth from '../../middleware/auth.js';
import requireCheckedIn from '../../middleware/requireCheckedIn.js';
import departmentFilter from '../../middleware/departmentFilter.js';
import Verification from './verification.model.js';
import { sendDispatchNotification, sendVerificationConfirmation } from '../interakt/interakt.service.js';

const router = express.Router();



router.get('/', auth('admin', 'manager', 'sales', 'support'), departmentFilter, async (req, res) => {
  try {
    const Lead = (await import('../lead/lead.model.js')).default;
    const User = (await import('../user/user.model.js')).default;

    const query = { status: { $nin: ['verified', 'on_hold'] }, isDeleted: { $ne: true } };
    if (req.query.department) {
      query.department = req.query.department;
      if (['sales', 'support', 'logistics'].includes(req.user.role) && req.userDepartments?.length > 0) {
        if (!req.userDepartments.includes(req.query.department)) query.department = "NOT_ALLOWED";
      }
    } else if (['sales', 'support', 'logistics'].includes(req.user.role)) {
      if (req.userDepartments && req.userDepartments.length > 0) {
        query.$or = [
          { department: { $in: req.userDepartments } },
          { department: null }
        ];
      }
    }

    // Apply day preset filter
    const dayFilter = req.query.dayFilter;
    const customDate = req.query.customDate;
    if (dayFilter === 'today' || dayFilter === 'yesterday' || dayFilter === 'custom') {
      const IST_OFFSET = 5.5 * 60 * 60 * 1000;
      const nowIST = new Date(Date.now() + IST_OFFSET);
      const todayIST = new Date(Date.UTC(nowIST.getUTCFullYear(), nowIST.getUTCMonth(), nowIST.getUTCDate()) - IST_OFFSET);
      const yesterdayIST = new Date(todayIST.getTime() - 24 * 60 * 60 * 1000);
      
      if (dayFilter === 'today') {
        query.createdAt = { $gte: todayIST };
      } else if (dayFilter === 'yesterday') {
        query.createdAt = { $gte: yesterdayIST, $lt: todayIST };
      } else if (dayFilter === 'custom' && customDate) {
        const from = new Date(`${customDate}T00:00:00.000+05:30`);
        const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
        query.createdAt = { $gte: from, $lt: to };
      }
    }

    // Apply text regex search matching
    const search = req.query.search;
    if (search) {
      const matchingLeads = await Lead.find({
        $or: [
          { name: new RegExp(search, 'i') },
          { phone: new RegExp(search, 'i') }
        ]
      }).select('_id').lean();
      const matchingLeadIds = matchingLeads.map(l => l._id);

      const matchingUsers = await User.find({
        name: new RegExp(search, 'i')
      }).select('_id').lean();
      const matchingUserIds = matchingUsers.map(u => u._id);

      query.$and = [
        ...(query.$and || []),
        {
          $or: [
            { title: new RegExp(search, 'i') },
            { lead: { $in: matchingLeadIds } },
            { assignedTo: { $in: matchingUserIds } },
            { district: new RegExp(search, 'i') }
          ]
        }
      ];
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 15;
    const skip = (page - 1) * limit;

    const total = await Verification.countDocuments(query);
    const records = await Verification.find(query)
      .populate('assignedTo', 'name email departments')
      .populate({
        path: 'lead',
        select: 'name phone status address houseNo cityVillage cityVillageType postOffice landmark district state pincode problem department createdBy pending_reorder_source',
        populate: { path: 'createdBy', select: 'name role' }
      })
      .populate('task', 'department')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    // Auto-backfill department from assignedTo.departments or lead.department if missing
    const deptUpdates = records.filter(r => !r.department);
    if (deptUpdates.length > 0) {
      deptUpdates.forEach(r => {
        const dept = r.assignedTo?.departments?.[0] || r.lead?.department || r.task?.department || 'migraine';
        r.department = dept;
        Verification.updateOne({ _id: r._id }, { $set: { department: dept } }).catch(err => console.error('[Verification] Auto-backfill dept error:', err.message));
      });
    }

    // Backfill relief_percentage from followups for records missing it
    try {
      const missing = records.filter(r => r.relief_percentage == null && r.lead);
      if (missing.length > 0) {
        const { Order } = (await import('../shiprocket/models/order.model.js'));
        const Followup = (await import('../shiprocket/models/followup.model.js')).default;
        const leadIds = missing.map(r => r.lead?._id || r.lead).filter(Boolean);
        const orders = await Order.find({ lead_id: { $in: leadIds } }).select('_id lead_id').lean();
        const orderMap = {};
        for (const o of orders) orderMap[String(o.lead_id)] = String(o._id);
        const orderIds = Object.values(orderMap).map(id => new mongoose.Types.ObjectId(id));

        // Query all latest followups with a relief_percentage in a single query
        const followupsList = await Followup.find({ 
          order_id: { $in: orderIds }, 
          relief_percentage: { $ne: null } 
        }).sort({ followup_number: -1 }).lean();

        // Map orderId to the latest relief_percentage
        const reliefMap = {};
        for (const f of followupsList) {
          const oId = String(f.order_id);
          if (reliefMap[oId] === undefined) {
            reliefMap[oId] = f.relief_percentage;
          }
        }

        // Apply relief_percentages in-memory and write to DB in background
        missing.forEach(r => {
          const leadId = String(r.lead?._id || r.lead);
          const orderId = orderMap[leadId];
          const relief = reliefMap[orderId];
          if (relief != null) {
            r.relief_percentage = relief;
            Verification.findByIdAndUpdate(r._id, { relief_percentage: relief }).catch(err => console.error('[Verification] Auto-backfill relief percentage error:', err.message));
          }
        });
      }
    } catch (backfillErr) {
      console.error('[Verification] backfill relief_percentage error:', backfillErr.message);
    }

    const leadIds = records.map(r => r.lead?._id || r.lead).filter(Boolean);
    const { Order } = (await import('../shiprocket/models/order.model.js'));
    const orderCounts = await Order.aggregate([
      { $match: { lead_id: { $in: leadIds } } },
      { $group: { _id: '$lead_id', count: { $sum: 1 } } }
    ]);
    const countMap = {};
    for (const oc of orderCounts) countMap[String(oc._id)] = oc.count;

    records.forEach(r => {
      const lId = String(r.lead?._id || r.lead);
      r.kit_number = (countMap[lId] || 0) + 1;
    });

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

router.get('/repair-dept', async (req, res) => {
  const User = (await import('../user/user.model.js')).default;
  const Task = (await import('../task/task.model.js')).default;
  const Lead = (await import('../lead/lead.model.js')).default;
  const records = await Verification.find({ department: null }).populate('assignedTo');
  let fixed = 0;
  for (const r of records) {
    if (r.assignedTo && r.assignedTo.departments && r.assignedTo.departments.length > 0) {
       const dept = r.assignedTo.departments[0];
       await Verification.updateOne({ _id: r._id }, { $set: { department: dept } });
       if (r.task) await Task.updateOne({ _id: r.task }, { $set: { department: dept } });
       if (r.lead) await Lead.updateOne({ _id: r.lead }, { $set: { department: dept } });
       fixed++;
    }
  }
  res.json({ message: `Fixed ${fixed} records completely` });
});

router.get('/test-data', async (req, res) => {
  const Task = (await import('../task/task.model.js')).default;
  const Lead = (await import('../lead/lead.model.js')).default;
  const records = await Verification.find().sort({ createdAt: -1 }).limit(20).populate('task').populate('lead').populate('assignedTo');
  
  let fixed = 0;
  for (const r of records) {
    if (!r.department) {
      let dept = 'migraine'; // aggressive fallback
      if (r.assignedTo && r.assignedTo.departments && r.assignedTo.departments.length > 0) {
        dept = r.assignedTo.departments[0];
      }
      await Verification.updateOne({ _id: r._id }, { $set: { department: dept } });
      if (r.task) await Task.updateOne({ _id: r.task._id || r.task }, { $set: { department: dept } });
      if (r.lead) await Lead.updateOne({ _id: r.lead._id || r.lead }, { $set: { department: dept } });
      fixed++;
    }
  }

  const updatedRecords = await Verification.find().sort({ createdAt: -1 }).limit(10).populate('task').populate('lead').lean();
  res.json({ fixed, data: updatedRecords.map(r => ({ title: r.title, dept: r.department, leadDept: r.lead?.department, taskDept: r.task?.department })) });
});

// Sync tasks with status 'verification' into Verification collection
router.post('/sync', auth('admin', 'manager', 'sales', 'support'), departmentFilter, requireCheckedIn, async (req, res) => {
  // Respond immediately so client never waits
  res.json({ status: 200, message: 'Sync started' });

  // Run the sync process asynchronously in the background
  (async () => {
    try {
      const Task = (await import('../task/task.model.js')).default;
      const verificationTasks = await Task.find({ status: 'verification', isDeleted: false }, '_id title assignedTo lead dueDate description cityVillageType cityVillage houseNo postOffice district landmark pincode state reminderAt notes problem age weight height otherProblems problemDuration price department');
      const existingTaskIds = await Verification.distinct('task');
      const existingSet = new Set(existingTaskIds.map(id => id.toString()));
      const newTasks = verificationTasks.filter(t => !existingSet.has(t._id.toString()));

      if (newTasks.length > 0) {
        try {
          await Verification.insertMany(
            newTasks.map(task => ({
              task: task._id, title: task.title, assignedTo: task.assignedTo, lead: task.lead,
              dueDate: task.dueDate, description: task.description,
              cityVillageType: task.cityVillageType, cityVillage: task.cityVillage,
              houseNo: task.houseNo, postOffice: task.postOffice, district: task.district,
              landmark: task.landmark, pincode: task.pincode, state: task.state,
              reminderAt: task.reminderAt, notes: task.notes,
              problem: task.problem, age: task.age, weight: task.weight, height: task.height,
              otherProblems: task.otherProblems, problemDuration: task.problemDuration, price: task.price,
              department: task.department,
            })),
            { ordered: false }
          );

          // Send WhatsApp confirmation to each new lead entering Verification
          const Lead = (await import('../lead/lead.model.js')).default;
          for (const task of newTasks) {
            try {
              let leadPhone = null;
              let leadName = null;
              let leadProblem = null;
              let leadAddress = null;

              if (task.lead) {
                const leadDoc = await Lead.findById(task.lead)
                  .select('name phone problem address houseNo cityVillage postOffice district state pincode')
                  .lean();
                if (leadDoc) {
                  leadPhone   = leadDoc.phone;
                  leadName    = leadDoc.name;
                  leadProblem = leadDoc.problem || '';
                  const addrParts = [
                    leadDoc.houseNo,
                    leadDoc.cityVillage,
                    leadDoc.postOffice,
                    leadDoc.district,
                    leadDoc.state,
                    leadDoc.pincode,
                  ].filter(Boolean);
                  leadAddress = addrParts.length > 0 ? addrParts.join(', ') : (leadDoc.address || '');
                }
              }

              const finalProblem = leadProblem || task.problem || '';
              const finalPrice   = task.price || '';
              const finalAddress = leadAddress || [
                task.houseNo, task.cityVillage, task.postOffice,
                task.district, task.state, task.pincode
              ].filter(Boolean).join(', ') || '';

              if (leadPhone) {
                await sendVerificationConfirmation({
                  phone: leadPhone,
                  customerName: leadName || task.title,
                  problem: finalProblem,
                  price: finalPrice,
                  address: finalAddress,
                });
              }
            } catch (waErr) {
              console.error('[WhatsApp] Verification confirmation error for task', task._id, ':', waErr.message);
            }
          }
        } catch (err) {
          // Ignore duplicate key errors (11000) during bulk insert
          if (err.code !== 11000) console.error('Sync insert error:', err);
        }
      }

      const existingTasks = verificationTasks.filter(t => existingSet.has(t._id.toString()));
      if (existingTasks.length > 0) {
        const ops = existingTasks.map(task => ({
          updateOne: {
            filter: { task: task._id },
            update: {
              $set: {
                title: task.title, assignedTo: task.assignedTo, lead: task.lead,
                age: task.age, weight: task.weight, height: task.height, price: task.price,
                problem: task.problem, otherProblems: task.otherProblems,
                problemDuration: task.problemDuration, description: task.description,
                cityVillageType: task.cityVillageType, cityVillage: task.cityVillage,
                houseNo: task.houseNo, postOffice: task.postOffice, district: task.district,
                landmark: task.landmark, pincode: task.pincode, state: task.state,
                reminderAt: task.reminderAt, department: task.department
              }
            }
          }
        }));
        await Verification.bulkWrite(ops, { ordered: false }).catch(err => console.error('Sync bulkWrite error:', err));
      }
    } catch (bgError) {
      console.error('[Verification Sync Background Error]:', bgError.message);
    }
  })();
});

// MUST be before /:id routes
router.post('/repair', auth('admin', 'manager', 'sales', 'support'), departmentFilter, requireCheckedIn, async (req, res) => {
  try {
    const Task = (await import('../task/task.model.js')).default;
    const ReadyToShipment = (await import('../readytoshipment/readytoshipment.model.js')).default;
    const Lead = (await import('../lead/lead.model.js')).default;

    // Fix on_hold: sync lead status
    const onHoldRecords = await Verification.find({ status: 'on_hold' }).lean();
    for (const record of onHoldRecords) {
      if (record.lead) await Lead.findByIdAndUpdate(record.lead, {
        status: 'on_hold',
        cnp: false,
        ...(record.onHoldReason && { onHoldReason: record.onHoldReason }),
        ...(record.onHoldUntil && { onHoldUntil: record.onHoldUntil }),
      });
      if (record.task) await Task.findByIdAndUpdate(record.task, { status: 'on_hold' });
    }

    const verifiedRecords = await Verification.find({ status: 'verified' })
      .populate('assignedTo', 'name email')
      .populate('lead', 'name phone status createdBy assignedTo pending_reorder_source');

    let fixed = 0;
    for (const record of verifiedRecords) {
      if (!record.task) continue;
      let rtsAssignedTo = record.assignedTo?._id || record.assignedTo;
      await Task.findByIdAndUpdate(record.task, { status: 'ready_to_shipment', assignedTo: rtsAssignedTo });
      await ReadyToShipment.findOneAndUpdate(
        { task: record.task },
        {
          $set: {
            title: record.title,
            assignedTo: rtsAssignedTo,
            lead: record.lead?._id || record.lead,
            description: record.description,
            problem: record.problem,
            age: record.age, weight: record.weight, height: record.height,
            otherProblems: record.otherProblems, problemDuration: record.problemDuration,
            price: record.price,
            cityVillageType: record.cityVillageType, cityVillage: record.cityVillage,
            houseNo: record.houseNo, postOffice: record.postOffice,
            district: record.district, landmark: record.landmark,
            pincode: record.pincode, state: record.state,
            reminderAt: record.reminderAt,
          },
          $setOnInsert: { task: record.task },
        },
        { upsert: true }
      );
      fixed++;
    }
    res.json({ status: 200, message: `Repaired ${fixed} records` });
  } catch (e) {
    res.status(500).json({ status: 500, message: e.message });
  }
});

router.get('/on-hold', auth('admin', 'manager', 'sales', 'support'), departmentFilter, async (req, res) => {
  try {
    const Lead = (await import('../lead/lead.model.js')).default;

    const query = { status: 'on_hold', isDeleted: { $ne: true } };
    if (req.query.department) {
      query.department = req.query.department;
      if (['sales', 'support', 'logistics'].includes(req.user.role) && req.userDepartments?.length > 0) {
        if (!req.userDepartments.includes(req.query.department)) query.department = "NOT_ALLOWED";
      }
    } else if (['sales', 'support', 'logistics'].includes(req.user.role)) {
      if (req.userDepartments && req.userDepartments.length > 0) {
        query.$or = [
          { department: { $in: req.userDepartments } },
          { department: null }
        ];
      }
    }

    // Get verification on-hold records
    const verificationRecords = await Verification.find(query)
      .populate('assignedTo', 'name email departments')
      .populate({
        path: 'lead',
        select: 'name phone status onHoldReason onHoldUntil address houseNo cityVillage cityVillageType postOffice landmark district state pincode problem createdBy pending_reorder_source',
        populate: { path: 'createdBy', select: 'name role' }
      })
      .sort({ onHoldUntil: -1 })
      .lean();

    // Auto-backfill department from assignedTo.departments or lead.department if missing
    const deptUpdates = verificationRecords.filter(r => !r.department);
    if (deptUpdates.length > 0) {
      await Promise.all(deptUpdates.map(r => {
        const dept = r.assignedTo?.departments?.[0] || r.lead?.department || 'migraine';
        r.department = dept;
        return Verification.updateOne({ _id: r._id }, { $set: { department: dept } });
      }));
    }

    // Get lead IDs already covered by verification records
    const verificationLeadIds = new Set(
      verificationRecords.map(r => r.lead?._id?.toString()).filter(Boolean)
    );

    const mongoose = (await import('mongoose')).default;
    const leadQuery = {
      status: 'on_hold',
      isDeleted: false,
      _id: { $nin: [...verificationLeadIds].map(id => new mongoose.Types.ObjectId(id)) },
    };
    if (req.query.department) {
      leadQuery.department = req.query.department;
      if (['sales', 'support', 'logistics'].includes(req.user.role) && req.userDepartments?.length > 0) {
        if (!req.userDepartments.includes(req.query.department)) leadQuery.department = "NOT_ALLOWED";
      }
    } else if (['sales', 'support', 'logistics'].includes(req.user.role)) {
      if (req.userDepartments && req.userDepartments.length > 0) {
        leadQuery.department = { $in: req.userDepartments };
      }
    }
    // Get pipeline on-hold leads NOT in verification
    const pipelineOnHoldLeads = await Lead.find(leadQuery)
      .populate('assignedTo', 'name email')
      .sort({ onHoldUntil: -1 })
      .lean();

    // Shape pipeline leads to match verification record structure
    const pipelineRecords = pipelineOnHoldLeads.map(lead => ({
      _id: lead._id,
      title: `Call ${lead.name}`,
      status: 'on_hold',
      onHoldReason: lead.onHoldReason,
      onHoldUntil: lead.onHoldUntil,
      assignedTo: lead.assignedTo,
      lead: lead,
      createdAt: lead.createdAt,
      _isPipelineOnly: true,
    }));

    // Filter by dayPreset
    const dayFilter = req.query.dayFilter;
    const customDate = req.query.customDate;
    let filteredRecords = [...verificationRecords, ...pipelineRecords];

    if (dayFilter === 'today' || dayFilter === 'yesterday' || dayFilter === 'custom') {
      const IST_OFFSET = 5.5 * 60 * 60 * 1000;
      const nowIST = new Date(Date.now() + IST_OFFSET);
      const todayIST = new Date(Date.UTC(nowIST.getUTCFullYear(), nowIST.getUTCMonth(), nowIST.getUTCDate()) - IST_OFFSET);
      const yesterdayIST = new Date(todayIST.getTime() - 24 * 60 * 60 * 1000);
      
      filteredRecords = filteredRecords.filter(r => {
        const dateVal = new Date(r.onHoldAt || r.updatedAt || r.createdAt);
        if (dayFilter === 'today') return dateVal >= todayIST;
        if (dayFilter === 'yesterday') return dateVal >= yesterdayIST && dateVal < todayIST;
        if (dayFilter === 'custom' && customDate) {
          const from = new Date(customDate);
          const to = new Date(from); to.setDate(from.getDate() + 1);
          return dateVal >= from && dateVal < to;
        }
        return true;
      });
    }

    // Filter by search term
    const search = req.query.search;
    if (search) {
      const q = search.toLowerCase();
      filteredRecords = filteredRecords.filter(r =>
        r.title?.toLowerCase().includes(q) ||
        r.lead?.name?.toLowerCase().includes(q) ||
        r.lead?.phone?.includes(q) ||
        r.assignedTo?.name?.toLowerCase().includes(q)
      );
    }

    const sortedRecords = filteredRecords.sort((a, b) => new Date(b.onHoldUntil || b.createdAt) - new Date(a.onHoldUntil || a.createdAt));

    const total = sortedRecords.length;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 15;
    const skip = (page - 1) * limit;
    const paginatedRecords = sortedRecords.slice(skip, skip + limit);

    const { Order } = (await import('../shiprocket/models/order.model.js'));
    const leadIds = paginatedRecords.map(r => r.lead?._id || r.lead).filter(Boolean);
    const orderCounts = await Order.aggregate([
      { $match: { lead_id: { $in: leadIds } } },
      { $group: { _id: '$lead_id', count: { $sum: 1 } } }
    ]);
    const countMap = {};
    for (const oc of orderCounts) countMap[String(oc._id)] = oc.count;

    paginatedRecords.forEach(r => {
      const lId = String(r.lead?._id || r.lead);
      r.kit_number = (countMap[lId] || 0) + 1;
    });

    res.json({
      status: 200,
      data: {
        records: paginatedRecords,
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

router.get('/by-task/:taskId', auth('admin', 'manager', 'sales', 'support'), departmentFilter, async (req, res) => {
  try {
    const record = await Verification.findOne({ task: req.params.taskId, isDeleted: { $ne: true } }).select('_id status').lean();
    if (!record) return res.status(404).json({ status: 404, message: 'Not found' });
    res.json({ status: 200, data: record });
  } catch (e) {
    res.status(500).json({ status: 500, message: e.message });
  }
});

router.patch('/:id', auth('admin', 'manager', 'sales', 'support'), departmentFilter, requireCheckedIn, async (req, res) => {
  try {
    const recordBefore = await Verification.findById(req.params.id);
    if (!recordBefore) return res.status(404).json({ message: 'Not found' });

    const { status, onHoldUntil, onHoldReason, ...taskFields } = req.body;
    const update = { ...taskFields };
    if (status) {
      update.status = status;
      if (!update.assignedTo) {
        if (!recordBefore.assignedTo) {
          update.assignedTo = req.user._id;
        }
      }
    }
    if (onHoldUntil) update.onHoldUntil = onHoldUntil;
    if (onHoldReason) update.onHoldReason = onHoldReason;
    if (status === 'on_hold') update.onHoldAt = new Date();

    const record = await Verification.findByIdAndUpdate(
      req.params.id,
      update,
      { returnDocument: 'after' }
    ).populate('assignedTo', 'name email').populate('lead', 'name phone status address houseNo cityVillage cityVillageType postOffice landmark district state pincode problem createdBy assignedTo pending_reorder_source');
    if (!record) return res.status(404).json({ message: 'Not found' });

    const Task = (await import('../task/task.model.js')).default;
    const ReadyToShipment = (await import('../readytoshipment/readytoshipment.model.js')).default;

    if (status === 'on_hold' && record.lead) {
      const Lead = (await import('../lead/lead.model.js')).default;
      const leadId = record.lead._id || record.lead;
      await Lead.findByIdAndUpdate(leadId, {
        status: 'on_hold',
        cnp: false,
        isDeleted: false,
        ...(onHoldReason && { onHoldReason }),
        ...(onHoldUntil && { onHoldUntil }),
      });
      // Set task status to on_hold so lead appears in Pipeline On Hold list
      if (record.task) {
        await Task.findByIdAndUpdate(record.task, { status: 'on_hold', isDeleted: false });
      }
    }

    if (status === 'pending' && record.lead) {
      const Lead = (await import('../lead/lead.model.js')).default;
      const leadId = record.lead._id || record.lead;
      await Lead.findByIdAndUpdate(leadId, { status: 'new', cnp: false, isDeleted: false });
      if (record.task) {
        await Task.findByIdAndUpdate(record.task, { status: 'verification', isDeleted: false });
      }
    }

    if (status === 'verified' && record.task) {
      let rtsAssignedTo = record.assignedTo?._id || record.assignedTo;

      const taskUpdate = await Task.findByIdAndUpdate(
        record.task,
        { status: 'ready_to_shipment', assignedTo: rtsAssignedTo, ...taskFields },
        { returnDocument: 'after' }
      );
      if (!taskUpdate) return res.status(500).json({ status: 500, message: 'Task not found' });

      await ReadyToShipment.findOneAndUpdate(
        { task: record.task },
        {
          $set: {
            title: record.title,
            assignedTo: rtsAssignedTo,
            lead: record.lead?._id || record.lead,
            description: record.description,
            problem: record.problem,
            age: record.age, weight: record.weight, height: record.height,
            otherProblems: record.otherProblems, problemDuration: record.problemDuration,
            price: record.price,
            cityVillageType: record.cityVillageType, cityVillage: record.cityVillage,
            houseNo: record.houseNo, postOffice: record.postOffice,
            district: record.district, landmark: record.landmark,
            pincode: record.pincode, state: record.state,
            reminderAt: record.reminderAt,
          },
          $setOnInsert: { task: record.task },
        },
        { upsert: true, returnDocument: 'after' }
      );

      // WhatsApp dispatch notification - smart sender (template + chat fallback)
      try {
        const customerPhone = record.lead?.phone;
        const customerName = record.lead?.name || 'Customer';
        if (customerPhone) {
          await sendDispatchNotification({
            phone: customerPhone,
            customerName,
            orderTitle: record.title,
            price: record.price,
          });
        }
      } catch (waErr) {
        console.error('⚠️ WhatsApp dispatch notification error:', waErr.message);
      }
    } else if (record.task && Object.keys(taskFields).length > 0) {
      await Task.findByIdAndUpdate(record.task, taskFields);
    }

    res.json({ status: 200, data: record });
  } catch (e) {
    res.status(500).json({ status: 500, message: e.message });
  }
});

router.delete('/:id', auth('admin', 'manager', 'sales', 'support'), departmentFilter, requireCheckedIn, async (req, res) => {
  try {
    const Lead = (await import('../lead/lead.model.js')).default;
    const Task = (await import('../task/task.model.js')).default;
    const leadService = await import('../lead/lead.service.js');

    const record = await Verification.findByIdAndUpdate(req.params.id, { isDeleted: true, deletedAt: new Date() }, { returnDocument: 'after' });

    if (record) {
      if (record.lead) {
        await leadService.deleteLead(record.lead).catch(() => { });
      } else if (record.task) {
        await Task.findByIdAndUpdate(record.task, { isDeleted: true, deletedAt: new Date() }).catch(() => { });
      }
      return res.json({ message: 'Verification record and associated lead soft deleted' });
    }

    // If not found in Verification, check if it's a Lead ID (pipeline-only on-hold records)
    try {
      await leadService.deleteLead(req.params.id);
      return res.json({ message: 'Pipeline record and associated tasks soft deleted' });
    } catch (err) {
      return res.json({ message: 'Record already deleted' });
    }
  } catch (e) {
    res.status(500).json({ status: 500, message: e.message });
  }
});

export default router;

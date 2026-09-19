import express from 'express';
import mongoose from 'mongoose';
import auth from '../../middleware/auth.js';
import requireCheckedIn from '../../middleware/requireCheckedIn.js';
import departmentFilter from '../../middleware/departmentFilter.js';
import Verification from './verification.model.js';
import Lead from '../lead/lead.model.js';
import User from '../user/user.model.js';
import { Order } from '../shiprocket/models/order.model.js';
import Followup from '../shiprocket/models/followup.model.js';
import { sendDispatchNotification, sendVerificationConfirmation } from '../interakt/interakt.service.js';
// ── Commission workflow: append-only chain entry + submitter lock ─────────────
import { appendOrderChain } from '../commission/orderChain.service.js';

const router = express.Router();

router.get('/', auth('admin', 'manager', 'sales', 'support'), departmentFilter, async (req, res) => {
  try {
    const query = { status: { $nin: ['verified', 'dispatch', 'dispatched', 'on_hold'] }, isDeleted: { $ne: true } };
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
      // Staff only see their own verification records (support and sales see all)
      if (!['support', 'sales'].includes(req.user.role)) {
        query.assignedTo = req.user._id;
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

    // Apply text search matching with parallel queries
    const search = req.query.search;
    if (search) {
      const searchRegex = new RegExp(search, 'i');
      const [matchingLeads, matchingUsers] = await Promise.all([
        Lead.find({
          $or: [{ name: searchRegex }, { phone: searchRegex }]
        }).select('_id').lean(),
        User.find({ name: searchRegex }).select('_id').lean()
      ]);

      const matchingLeadIds = matchingLeads.map(l => l._id);
      const matchingUserIds = matchingUsers.map(u => u._id);

      query.$and = [
        ...(query.$and || []),
        {
          $or: [
            { title: searchRegex },
            { lead: { $in: matchingLeadIds } },
            { assignedTo: { $in: matchingUserIds } },
            { district: searchRegex }
          ]
        }
      ];
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 15;
    const skip = (page - 1) * limit;

    // Parallelize countDocuments and find records
    const [total, records] = await Promise.all([
      Verification.countDocuments(query),
      Verification.find(query)
        .populate('assignedTo', 'name email departments')
        .populate('verifiedBy', 'name email')
        .populate({
          path: 'lead',
          select: 'name phone status address houseNo cityVillage cityVillageType postOffice landmark district state pincode problem department createdBy pending_reorder_source',
          populate: { path: 'createdBy', select: 'name role' }
        })
        .populate({
          path: 'task',
          select: 'department createdBy',
          populate: { path: 'createdBy', select: 'name role' }
        })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
    ]);

    // Async background auto-backfill of department if missing
    const deptUpdates = records.filter(r => !r.department);
    if (deptUpdates.length > 0) {
      deptUpdates.forEach(r => {
        const dept = r.assignedTo?.departments?.[0] || r.lead?.department || r.task?.department || 'migraine';
        r.department = dept;
        Verification.updateOne({ _id: r._id }, { $set: { department: dept } }).catch(() => {});
      });
    }

    const leadIds = records.map(r => r.lead?._id || r.lead).filter(Boolean);
    if (leadIds.length > 0) {
      const missingReliefRecords = records.filter(r => r.relief_percentage == null && r.lead);

      const [orderCounts, ordersForRelief] = await Promise.all([
        Order.aggregate([
          { $match: { lead_id: { $in: leadIds } } },
          { $group: { _id: '$lead_id', count: { $sum: 1 } } }
        ]),
        missingReliefRecords.length > 0
          ? Order.find({ lead_id: { $in: missingReliefRecords.map(r => r.lead?._id || r.lead) } }).select('_id lead_id').lean()
          : Promise.resolve([])
      ]);

      const countMap = {};
      for (const oc of orderCounts) countMap[String(oc._id)] = oc.count;

      records.forEach(r => {
        const lId = String(r.lead?._id || r.lead);
        r.kit_number = (countMap[lId] || 0) + 1;
      });

      if (ordersForRelief.length > 0) {
        const orderMap = {};
        for (const o of ordersForRelief) orderMap[String(o.lead_id)] = String(o._id);
        const orderIds = Object.values(orderMap).map(id => new mongoose.Types.ObjectId(id));

        const followupsList = await Followup.find({ 
          order_id: { $in: orderIds }, 
          relief_percentage: { $ne: null } 
        }).sort({ followup_number: -1 }).lean();

        const reliefMap = {};
        for (const f of followupsList) {
          const oId = String(f.order_id);
          if (reliefMap[oId] === undefined) {
            reliefMap[oId] = f.relief_percentage;
          }
        }

        missingReliefRecords.forEach(r => {
          const leadId = String(r.lead?._id || r.lead);
          const orderId = orderMap[leadId];
          const relief = reliefMap[orderId];
          if (relief != null) {
            r.relief_percentage = relief;
            Verification.findByIdAndUpdate(r._id, { relief_percentage: relief }).catch(() => {});
          }
        });
      }
    }

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

          // ── Commission Chain: Lock submitter ID for each new FIRST-ORDER task ──
          // appendOrderChain is idempotent — safe to call even if called more than once.
          // The submitter_id (req.user._id) is frozen at this point and never changed.
          for (const task of newTasks) {
            try {
              if (task.lead) {
                let detectedModel = 'ShiprocketOrder';
                try {
                  const { ShipmaxxOrder } = await import('../shipmaxx/models/shipmaxxOrder.model.js');
                  const smxOrder = await ShipmaxxOrder.findOne({ lead_id: task.lead }).select('_id').lean();
                  if (smxOrder) detectedModel = 'ShipmaxxOrder';
                } catch (_) {}

                await appendOrderChain({
                  leadId:       task.lead,
                  orderId:      null,            // order not yet created at this stage
                  orderModel:   detectedModel,
                  submitterId:  task.assignedTo || req.user._id,
                  orderType:    'first',
                  orderSubTotal: 0,             // not yet known; updated when order placed
                  actor:        req.user,
                });
              }
            } catch (chainErr) {
              console.error('[OrderChain] First-order chain entry failed for task', task._id, ':', chainErr.message);
            }
          }

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
                // NOTE: assignedTo is intentionally excluded here to preserve the original
                // closer's name. Only metadata/content fields are synced.
                title: task.title, lead: task.lead,
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
      let rtsAssignedTo = record.assignedTo?._id || record.assignedTo;
      const leadId = record.lead?._id || record.lead;

      let taskId = record.task;
      if (!taskId && leadId) {
        let existingTask = await Task.findOne({ lead: leadId, isDeleted: false });
        if (!existingTask) {
          existingTask = await Task.create({
            title: record.title || 'Verified Order',
            lead: leadId,
            assignedTo: rtsAssignedTo,
            department: record.department,
            status: 'dispatch',
            createdBy: rtsAssignedTo
          });
        }
        taskId = existingTask._id;
        await Verification.findByIdAndUpdate(record._id, { task: taskId });
      }

      if (taskId) {
        await Task.collection.updateOne({ _id: new mongoose.Types.ObjectId(taskId) }, { $set: { status: 'dispatch', assignedTo: new mongoose.Types.ObjectId(rtsAssignedTo), isDeleted: false } });
        await ReadyToShipment.findOneAndUpdate(
          { $or: [{ task: taskId }, { lead: leadId }] },
          {
            $set: {
              task: taskId,
              title: record.title,
              assignedTo: rtsAssignedTo,
              lead: leadId,
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
              isDeleted: false,
              isArchived: false,
              sentToShiprocket: false,
              updatedAt: new Date(),
            },
          },
          { upsert: true }
        );
        fixed++;
      }
    }
    res.json({ status: 200, message: `Repaired ${fixed} records` });
  } catch (e) {
    res.status(500).json({ status: 500, message: e.message });
  }
});

router.get('/on-hold', auth('admin', 'manager', 'sales', 'support'), departmentFilter, async (req, res) => {
  try {
    const Lead = (await import('../lead/lead.model.js')).default;

    const query = { 
      status: 'on_hold', 
      $or: [
        { isDeleted: { $ne: true } },
        { isDeleted: true, transferredTo: 'onholdorders' }
      ]
    };
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
      // Staff only see their own verification records (support and sales see all)
      if (!['support', 'sales'].includes(req.user.role)) {
        query.assignedTo = req.user._id;
      }
    }

    // Get verification on-hold records
    const verificationRecords = await Verification.find(query)
      .populate('assignedTo', 'name email departments')
      .populate('verifiedBy', 'name email')
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
      $or: [
        { isDeleted: { $ne: true } },
        { isDeleted: true, transferredTo: 'onholdorders' }
      ],
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
      title: lead.name,
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

    const { status, onHoldUntil, onHoldReason, assignedTo: incomingAssignedTo, ...taskFields } = req.body;
    const update = { ...taskFields };

    // assignedTo: only admin can explicitly change it (via assign modal).
    // For all other updates (price, address, etc.) preserve the original owner.
    if (incomingAssignedTo && req.user.role === 'admin') {
      update.assignedTo = incomingAssignedTo;
    }

    if (status) {
      update.status = status;
      if (status === 'verified' || status === 'dispatch' || status === 'dispatched') {
        // Jo bhi verification me laya tha (assignedTo) — usi ko 100% credit.
        // Button koi bhi dabaye, original owner ka verifiedBy set hoga.
        update.verifiedBy = recordBefore.assignedTo || req.user._id;
        // Agar koi owner hi nahi tha, to verify karne wala hi owner ban jaaye
        if (!recordBefore.assignedTo && !update.assignedTo) {
          update.assignedTo = req.user._id;
        }
      } else if (!update.assignedTo && !recordBefore.assignedTo) {
        // Pehli baar koi action le raha hai aur koi owner nahi — use hi assign karo
        update.assignedTo = req.user._id;
      }
    }
    if (onHoldUntil) update.onHoldUntil = onHoldUntil;
    if (onHoldReason) update.onHoldReason = onHoldReason;
    if (status === 'on_hold') update.onHoldAt = new Date();

    const record = await Verification.findByIdAndUpdate(
      req.params.id,
      update,
      { returnDocument: 'after' }
    )
      .populate('assignedTo', 'name email')
      .populate('verifiedBy', 'name email')
      .populate('lead', 'name phone status address houseNo cityVillage cityVillageType postOffice landmark district state pincode problem createdBy assignedTo pending_reorder_source');
    if (!record) return res.status(404).json({ message: 'Not found' });

    if (record.lead) {
      const Lead = (await import('../lead/lead.model.js')).default;
      const leadId = record.lead._id || record.lead;
      const profileFields = {
        houseNo: record.houseNo,
        cityVillage: record.cityVillage,
        cityVillageType: record.cityVillageType,
        postOffice: record.postOffice,
        district: record.district,
        state: record.state,
        pincode: record.pincode,
        landmark: record.landmark,
        problem: record.problem,
        age: record.age,
        weight: record.weight,
        height: record.height,
        otherProblems: record.otherProblems,
        problemDuration: record.problemDuration,
        department: record.department
      };
      Object.keys(profileFields).forEach(key => profileFields[key] === undefined && delete profileFields[key]);
      await Lead.findByIdAndUpdate(leadId, { $set: profileFields }).catch(() => {});
    }

    const Task = (await import('../task/task.model.js')).default;
    const ReadyToShipment = (await import('../readytoshipment/readytoshipment.model.js')).default;

    if (status && record && record._id) {
      try {
        const { transitionRecord } = await import('../transition/transition.service.js');
        let transTarget = status === 'rejected' ? 'closed_lost' : (status === 'verified' ? 'dispatch' : status);
        let originModel = Verification;
        
        if (recordBefore.status === 'on_hold') {
          const { OnHoldOrder } = await import('../transition/statusModels.js');
          originModel = OnHoldOrder;
        }

        if (status === 'pending') {
          transTarget = 'verification'; // route to verifications collection
        }
        const transUpdate = { ...update };
        if (transUpdate.status) transUpdate.status = transTarget;
        const transRecordId = recordBefore.status === 'on_hold' ? (record.lead?._id || record.lead) : record._id;
        await transitionRecord(originModel, transRecordId, transTarget, transUpdate, req.user?._id || req.user || null);
        
        // Restore correct 'pending' status after routing if we faked the target
        if (status === 'pending') {
          await Verification.updateOne({ _id: record._id }, { $set: { status: 'pending' } });
        }
      } catch (transErr) {
        console.error('[transitionRecord] Verification transition note:', transErr.message);
      }
    }

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
      await Lead.findByIdAndUpdate(leadId, { status: 'verification', cnp: false, isDeleted: false });
      if (record.task) {
        await Task.findByIdAndUpdate(record.task, { status: 'verification', isDeleted: false });
      }
    }

    if (status === 'verified' || status === 'dispatch' || status === 'dispatched') {
      let rtsAssignedTo = record.assignedTo?._id || record.assignedTo;
      const leadId = record.lead?._id || record.lead;

      // ── Commission Chain: Lock submitter ID for REPEAT ORDER at verification submit ──
      // This is the canonical trigger point for the 50-50 split (requirement step 4-5).
      // For repeat orders (lead.pending_reorder_source is set), the CURRENT submitter
      // (req.user._id) is locked to this chain entry. The system then reads the first
      // chain entry to find the original salesperson and splits commission 50-50.
      try {
        if (leadId) {
          const leadDoc = record.lead;  // already populated above
          const isRepeatOrder = !!(leadDoc?.pending_reorder_source);
          const orderType = isRepeatOrder ? 'repeat' : 'first';

          // ── Detect the correct order model (ShiprocketOrder vs ShipmaxxOrder) ──
          // Shipmaxx repeat orders arrive here via sendToVerification in shipmaxx.controller,
          // which already calls appendOrderChain directly with 'ShipmaxxOrder'.
          // For the generic verification PATCH, we detect by checking the source order's platform.
          let detectedOrderModel = 'ShiprocketOrder'; // default
          if (leadDoc?.pending_reorder_source) {
            try {
              // Check if the source order exists in ShipmaxxOrder collection first
              const { ShipmaxxOrder } = await import('../shipmaxx/models/shipmaxxOrder.model.js');
              const smxSource = await ShipmaxxOrder.findById(leadDoc.pending_reorder_source).select('_id platform').lean();
              if (smxSource) detectedOrderModel = 'ShipmaxxOrder';
            } catch (_) { /* keep default ShiprocketOrder */ }
          } else {
            // No source order — check if any existing chain entries are Shipmaxx
            const OrderChain = (await import('../commission/orderChain.model.js')).default;
            const existingEntry = await OrderChain.findOne({ lead_id: leadId }).sort({ chain_seq: -1 }).lean();
            if (existingEntry?.order_model === 'ShipmaxxOrder') detectedOrderModel = 'ShipmaxxOrder';
          }

          // Only create a repeat entry here; first-order entry was created at /sync time.
          // If for any reason /sync was missed, appendOrderChain is idempotent and will
          // create the first entry too (it checks for existing entries before inserting).
          // Note: Shipmaxx repeat orders are ALREADY handled in shipmaxx.controller.js
          // sendToVerification — this block handles Shiprocket + any edge cases.
          await appendOrderChain({
            leadId,
            orderId:      null,   // order not yet assigned at verification stage
            orderModel:   detectedOrderModel,
            submitterId:  req.user._id,   // LOCKED — this is the current submitter
            orderType,
            orderSubTotal: record.price || 0,
            actor:        req.user,
          });
        }
      } catch (chainErr) {
        // Commission chain errors must not block the verification dispatch flow.
        console.error('[OrderChain] Verification chain entry failed:', chainErr.message);
      }

      // Ensure task exists
      let taskId = record.task;
      if (!taskId && leadId) {
        let existingTask = await Task.findOne({ lead: leadId, isDeleted: false });
        if (!existingTask) {
          existingTask = await Task.create({
            title: record.title || 'Verified Order',
            lead: leadId,
            assignedTo: rtsAssignedTo,
            department: record.department,
            status: 'dispatch',
            createdBy: req.user?._id || rtsAssignedTo
          });
        }
        taskId = existingTask._id;
        await Verification.findByIdAndUpdate(record._id, { task: taskId });
      }

      if (leadId) {
        const Lead = (await import('../lead/lead.model.js')).default;
        const currentLead = await Lead.findById(leadId).lean();
        const newStatus = currentLead?.status === 'old' ? 'old' : 'dispatch';
        await Lead.findByIdAndUpdate(leadId, { assignedTo: rtsAssignedTo, status: newStatus });
      }

      if (taskId) {
        const updateDoc = { status: 'dispatch', assignedTo: new mongoose.Types.ObjectId(rtsAssignedTo), isDeleted: false };
        if (taskFields) Object.assign(updateDoc, taskFields);
        await Task.collection.updateOne(
          { _id: new mongoose.Types.ObjectId(taskId) },
          { $set: updateDoc }
        );

        const rtsDoc = await ReadyToShipment.findOneAndUpdate(
          { $or: [{ task: taskId }, { lead: leadId }] },
          {
            $set: {
              task: taskId,
              title: record.title,
              assignedTo: rtsAssignedTo,
              lead: leadId,
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
              isDeleted: false,
              isArchived: false,
              sentToShiprocket: false,
            },
          },
          { upsert: true, returnDocument: 'after' }
        );

        if (rtsDoc) {
          await ReadyToShipment.collection.updateOne(
            { _id: rtsDoc._id },
            { $set: { createdAt: new Date(), updatedAt: new Date() } }
          );
        }
      }

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

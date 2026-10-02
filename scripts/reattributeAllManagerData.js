import mongoose from 'mongoose';
import { config } from '../src/config/config.js';
import User from '../src/modules/user/user.model.js';
import Lead from '../src/modules/lead/lead.model.js';
import Task from '../src/modules/task/task.model.js';
import { Order } from '../src/modules/shiprocket/models/order.model.js';
import { ShipmaxxOrder } from '../src/modules/shipmaxx/models/shipmaxxOrder.model.js';
import Verification from '../src/modules/verification/verification.model.js';

async function runFullReattribution() {
  try {
    console.log('Connecting to database...');
    await mongoose.connect(config.mongoose.url, config.mongoose.options);
    console.log('Database connected successfully.');

    // 1. Load users & identify Manager/Logistics/Admin vs Sales/Support
    const users = await User.find({}).select('_id name role department').lean();
    const userRoleMap = new Map();
    const managerIds = [];
    const salesSupportIds = [];

    for (const u of users) {
      const sId = String(u._id);
      userRoleMap.set(sId, u.role);
      if (['manager', 'logistics', 'admin'].includes(u.role)) {
        managerIds.push(u._id);
      } else if (['sales', 'support'].includes(u.role)) {
        salesSupportIds.push(u._id);
      }
    }

    const managerStrSet = new Set(managerIds.map(String));
    console.log(`Found ${users.length} total users (${managerIds.length} Manager/Logistics/Admin, ${salesSupportIds.length} Sales/Support).`);

    // 2. Fix Lead assignments currently set to Manager/Logistics/Admin
    const managerLeads = await Lead.find({ assignedTo: { $in: managerIds } })
      .select('_id phone assignedTo createdBy notes follow_ups status')
      .lean();

    const leadOps = [];
    for (const l of managerLeads) {
      let salesAgentId = null;

      // Check notes for a sales/support agent
      if (l.notes && l.notes.length) {
        for (const n of l.notes) {
          if (n.createdBy) {
            const role = userRoleMap.get(String(n.createdBy));
            if (['sales', 'support'].includes(role)) {
              salesAgentId = String(n.createdBy);
              break;
            }
          }
        }
      }

      // Check follow_ups
      if (!salesAgentId && l.follow_ups && l.follow_ups.length) {
        for (const f of l.follow_ups) {
          if (f.createdBy) {
            const role = userRoleMap.get(String(f.createdBy));
            if (['sales', 'support'].includes(role)) {
              salesAgentId = String(f.createdBy);
              break;
            }
          }
        }
      }

      // Check Task assignedTo
      if (!salesAgentId) {
        const task = await Task.findOne({ lead: l._id, assignedTo: { $nin: managerIds } }).lean();
        if (task && task.assignedTo) {
          const role = userRoleMap.get(String(task.assignedTo));
          if (['sales', 'support'].includes(role)) {
            salesAgentId = String(task.assignedTo);
          }
        }
      }

      // If a sales agent was found, re-assign lead to that sales agent!
      if (salesAgentId) {
        leadOps.push({
          updateOne: {
            filter: { _id: l._id },
            update: { $set: { assignedTo: new mongoose.Types.ObjectId(salesAgentId) } }
          }
        });
      }
    }

    if (leadOps.length > 0) {
      await Lead.bulkWrite(leadOps);
      console.log(`Re-assigned ${leadOps.length} manager-assigned Leads to real Sales/Support agents.`);
    }

    // 3. Re-build Phone-to-Sales mapping with updated Leads
    const allLeads = await Lead.find({ assignedTo: { $nin: managerIds, $ne: null } })
      .select('_id phone assignedTo')
      .lean();

    const phoneToSalesMap = new Map();
    const leadMap = new Map();

    for (const l of allLeads) {
      const lId = String(l._id);
      leadMap.set(lId, l);

      if (l.phone && l.assignedTo) {
        const cleanP = String(l.phone).replace(/\D/g, '').slice(-10);
        if (cleanP && cleanP.length >= 10 && !phoneToSalesMap.has(cleanP)) {
          phoneToSalesMap.set(cleanP, String(l.assignedTo));
        }
      }
    }

    console.log(`Phone-to-sales map ready with ${phoneToSalesMap.size} customer numbers.`);

    // 4. Helper function to find best Sales/Support agent for an order
    const getBestAgent = (o) => {
      // 1. Lead assignedTo
      if (o.lead_id) {
        const leadObj = leadMap.get(String(o.lead_id._id || o.lead_id));
        if (leadObj && leadObj.assignedTo) {
          const role = userRoleMap.get(String(leadObj.assignedTo));
          if (['sales', 'support'].includes(role)) return String(leadObj.assignedTo);
        }
      }
      // 2. Phone lookup
      const phone = (o.billing_phone || (o.lead_id && o.lead_id.phone))?.replace(/\D/g, '').slice(-10);
      if (phone && phoneToSalesMap.has(phone)) {
        return phoneToSalesMap.get(phone);
      }
      // 3. Existing non-manager fields
      for (const fId of [o.task_created_by, o.verified_by, o.created_by].filter(Boolean).map(String)) {
        if (!managerStrSet.has(fId) && ['sales', 'support'].includes(userRoleMap.get(fId))) {
          return fId;
        }
      }
      return null;
    };

    // 5. Query and Bulk Update Shiprocket Orders
    const query = {
      $or: [
        { verified_by: { $in: managerIds } },
        { created_by: { $in: managerIds } },
        { task_created_by: { $in: managerIds } }
      ]
    };

    const targetSR = await Order.find(query)
      .select('_id billing_phone lead_id created_by task_created_by verified_by verification_id')
      .populate('lead_id', 'assignedTo phone')
      .lean();

    const srOps = [];
    for (const o of targetSR) {
      const agentId = getBestAgent(o);
      if (agentId) {
        const setObj = {};
        if (o.verified_by && managerStrSet.has(String(o.verified_by))) setObj.verified_by = new mongoose.Types.ObjectId(agentId);
        if (o.created_by && managerStrSet.has(String(o.created_by))) setObj.created_by = new mongoose.Types.ObjectId(agentId);
        if (o.task_created_by && managerStrSet.has(String(o.task_created_by))) setObj.task_created_by = new mongoose.Types.ObjectId(agentId);

        if (Object.keys(setObj).length > 0) {
          srOps.push({ updateOne: { filter: { _id: o._id }, update: { $set: setObj } } });
        }
      }
    }
    if (srOps.length > 0) {
      await Order.bulkWrite(srOps);
    }
    console.log(`Re-attributed ${srOps.length} remaining Shiprocket orders.`);

    // 6. Query and Bulk Update Shipmaxx Orders
    const targetSM = await ShipmaxxOrder.find(query)
      .select('_id billing_phone lead_id created_by task_created_by verified_by verification_id')
      .populate('lead_id', 'assignedTo phone')
      .lean();

    const smOps = [];
    for (const o of targetSM) {
      const agentId = getBestAgent(o);
      if (agentId) {
        const setObj = {};
        if (o.verified_by && managerStrSet.has(String(o.verified_by))) setObj.verified_by = new mongoose.Types.ObjectId(agentId);
        if (o.created_by && managerStrSet.has(String(o.created_by))) setObj.created_by = new mongoose.Types.ObjectId(agentId);
        if (o.task_created_by && managerStrSet.has(String(o.task_created_by))) setObj.task_created_by = new mongoose.Types.ObjectId(agentId);

        if (Object.keys(setObj).length > 0) {
          smOps.push({ updateOne: { filter: { _id: o._id }, update: { $set: setObj } } });
        }
      }
    }
    if (smOps.length > 0) {
      await ShipmaxxOrder.bulkWrite(smOps);
    }
    console.log(`Re-attributed ${smOps.length} remaining Shipmaxx orders.`);

    // 7. Bulk Update Verification records
    const targetVerifs = await Verification.find({
      $or: [
        { verifiedBy: { $in: managerIds } },
        { assignedTo: { $in: managerIds } }
      ]
    }).populate('lead', 'assignedTo').lean();

    const verifOps = [];
    for (const v of targetVerifs) {
      let agentId = null;
      if (v.assignedTo && !managerStrSet.has(String(v.assignedTo))) {
        const role = userRoleMap.get(String(v.assignedTo));
        if (['sales', 'support'].includes(role)) agentId = String(v.assignedTo);
      }
      if (!agentId && v.lead && v.lead.assignedTo) {
        const role = userRoleMap.get(String(v.lead.assignedTo));
        if (['sales', 'support'].includes(role)) agentId = String(v.lead.assignedTo);
      }
      if (agentId) {
        const setObj = {};
        if (v.verifiedBy && managerStrSet.has(String(v.verifiedBy))) setObj.verifiedBy = new mongoose.Types.ObjectId(agentId);
        if (v.assignedTo && managerStrSet.has(String(v.assignedTo))) setObj.assignedTo = new mongoose.Types.ObjectId(agentId);

        if (Object.keys(setObj).length > 0) {
          verifOps.push({ updateOne: { filter: { _id: v._id }, update: { $set: setObj } } });
        }
      }
    }
    if (verifOps.length > 0) {
      await Verification.bulkWrite(verifOps);
    }
    console.log(`Re-attributed ${verifOps.length} Verification records.`);

    console.log('✅ FULL REATTRIBUTION COMPLETE! ALL MANAGER DATA CLEANED UP.');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error during full reattribution:', err);
    process.exit(1);
  }
}

runFullReattribution();

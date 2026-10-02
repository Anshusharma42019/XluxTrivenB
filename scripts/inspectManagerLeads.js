import mongoose from 'mongoose';
import { config } from '../src/config/config.js';
import User from '../src/modules/user/user.model.js';
import Lead from '../src/modules/lead/lead.model.js';
import { Order } from '../src/modules/shiprocket/models/order.model.js';
import { ShipmaxxOrder } from '../src/modules/shipmaxx/models/shipmaxxOrder.model.js';
import Verification from '../src/modules/verification/verification.model.js';
import Task from '../src/modules/task/task.model.js';

async function inspectManagerLeads() {
  try {
    await mongoose.connect(config.mongoose.url, config.mongoose.options);
    const users = await User.find({}).select('_id name role department').lean();
    const userRoleMap = new Map();
    const managerIds = [];

    for (const u of users) {
      const sId = String(u._id);
      userRoleMap.set(sId, u.role);
      if (['manager', 'logistics', 'admin'].includes(u.role)) {
        managerIds.push(u._id);
      }
    }

    const managerLeads = await Lead.find({ assignedTo: { $in: managerIds } })
      .select('_id phone assignedTo createdBy notes follow_ups status createdAt')
      .lean();

    console.log(`Analyzing ${managerLeads.length} leads assigned to Manager/Logistics/Admin...`);

    let salesFoundCount = 0;
    let fallbackSalesCount = 0;

    // Get active sales agents
    const salesAgents = users.filter(u => u.role === 'sales');
    console.log(`Active Sales Agents (${salesAgents.length}):`, salesAgents.map(u => `${u.name} (${u._id})`));

    for (const l of managerLeads) {
      let foundSales = null;

      // Check notes
      if (l.notes && l.notes.length) {
        for (const n of l.notes) {
          if (n.createdBy) {
            const r = userRoleMap.get(String(n.createdBy));
            if (r === 'sales') {
              foundSales = String(n.createdBy);
              break;
            }
          }
        }
      }

      // Check follow_ups
      if (!foundSales && l.follow_ups && l.follow_ups.length) {
        for (const f of l.follow_ups) {
          if (f.createdBy) {
            const r = userRoleMap.get(String(f.createdBy));
            if (r === 'sales') {
              foundSales = String(f.createdBy);
              break;
            }
          }
        }
      }

      // Check tasks
      if (!foundSales) {
        const task = await Task.findOne({ lead: l._id, assignedTo: { $nin: managerIds } }).lean();
        if (task && task.assignedTo) {
          const r = userRoleMap.get(String(task.assignedTo));
          if (['sales', 'support'].includes(r)) {
            foundSales = String(task.assignedTo);
          }
        }
      }

      if (foundSales) {
        salesFoundCount++;
      } else {
        fallbackSalesCount++;
      }
    }

    console.log(`Analysis: ${salesFoundCount} leads have activity by a Sales/Support agent. ${fallbackSalesCount} leads have no sales activity.`);

    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

inspectManagerLeads();

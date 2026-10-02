import mongoose from 'mongoose';
import { config } from '../src/config/config.js';
import User from '../src/modules/user/user.model.js';
import Lead from '../src/modules/lead/lead.model.js';
import { Order } from '../src/modules/shiprocket/models/order.model.js';
import { ShipmaxxOrder } from '../src/modules/shipmaxx/models/shipmaxxOrder.model.js';
import Verification from '../src/modules/verification/verification.model.js';

async function cleanupAllRemainingManagerRecords() {
  try {
    await mongoose.connect(config.mongoose.url, config.mongoose.options);
    const users = await User.find({}).select('_id name role department').lean();
    
    const managerIds = users.filter(u => ['manager', 'logistics', 'admin'].includes(u.role)).map(u => u._id);
    const salesUsers = users.filter(u => u.role === 'sales');
    const supportUsers = users.filter(u => u.role === 'support');
    const salesSupportUsers = [...salesUsers, ...supportUsers];

    if (salesSupportUsers.length === 0) {
      console.log('No Sales/Support users found.');
      process.exit(0);
    }

    console.log(`Sales/Support staff available for attribution (${salesSupportUsers.length}):`, salesSupportUsers.map(u => u.name));

    // Primary default sales agent for orphan manager leads/orders
    const defaultSalesAgent = salesUsers[0] || salesSupportUsers[0];
    console.log(`Default fallback sales agent: ${defaultSalesAgent.name} (${defaultSalesAgent._id})`);

    // 1. Clean up remaining Manager Leads -> distribute among Sales staff round-robin
    const orphanLeads = await Lead.find({ assignedTo: { $in: managerIds } }).select('_id').lean();
    if (orphanLeads.length > 0) {
      const leadOps = orphanLeads.map((l, idx) => ({
        updateOne: {
          filter: { _id: l._id },
          update: { $set: { assignedTo: salesUsers[idx % salesUsers.length]._id } }
        }
      }));
      await Lead.bulkWrite(leadOps);
      console.log(`Re-assigned ${orphanLeads.length} remaining orphan manager leads to Sales team.`);
    }

    // 2. Clean up remaining Manager Verifications
    const orphanVerifs = await Verification.find({
      $or: [{ assignedTo: { $in: managerIds } }, { verifiedBy: { $in: managerIds } }]
    }).populate('lead', 'assignedTo').lean();

    if (orphanVerifs.length > 0) {
      const verifOps = orphanVerifs.map((v, idx) => {
        const leadAgent = v.lead && v.lead.assignedTo ? v.lead.assignedTo : salesSupportUsers[idx % salesSupportUsers.length]._id;
        return {
          updateOne: {
            filter: { _id: v._id },
            update: {
              $set: {
                assignedTo: leadAgent,
                verifiedBy: leadAgent
              }
            }
          }
        };
      });
      await Verification.bulkWrite(verifOps);
      console.log(`Re-attributed ${orphanVerifs.length} remaining manager verifications.`);
    }

    // 3. Clean up remaining Manager Shiprocket Orders
    const query = {
      $or: [
        { verified_by: { $in: managerIds } },
        { created_by: { $in: managerIds } },
        { task_created_by: { $in: managerIds } }
      ]
    };

    const orphanSR = await Order.find(query).populate('lead_id', 'assignedTo').lean();
    if (orphanSR.length > 0) {
      const srOps = orphanSR.map((o, idx) => {
        const leadAgent = o.lead_id && o.lead_id.assignedTo ? o.lead_id.assignedTo : salesUsers[idx % salesUsers.length]._id;
        return {
          updateOne: {
            filter: { _id: o._id },
            update: {
              $set: {
                verified_by: leadAgent,
                created_by: leadAgent,
                task_created_by: leadAgent
              }
            }
          }
        };
      });
      await Order.bulkWrite(srOps);
      console.log(`Re-attributed ${orphanSR.length} remaining manager Shiprocket orders.`);
    }

    // 4. Clean up remaining Manager Shipmaxx Orders
    const orphanSM = await ShipmaxxOrder.find(query).populate('lead_id', 'assignedTo').lean();
    if (orphanSM.length > 0) {
      const smOps = orphanSM.map((o, idx) => {
        const leadAgent = o.lead_id && o.lead_id.assignedTo ? o.lead_id.assignedTo : salesUsers[idx % salesUsers.length]._id;
        return {
          updateOne: {
            filter: { _id: o._id },
            update: {
              $set: {
                verified_by: leadAgent,
                created_by: leadAgent,
                task_created_by: leadAgent
              }
            }
          }
        };
      });
      await ShipmaxxOrder.bulkWrite(smOps);
      console.log(`Re-attributed ${orphanSM.length} remaining manager Shipmaxx orders.`);
    }

    console.log('💯 100% OF MANAGER DATA HAS BEEN REATTRIBUTED TO SALES/SUPPORT AGENTS!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error during final cleanup:', err);
    process.exit(1);
  }
}

cleanupAllRemainingManagerRecords();

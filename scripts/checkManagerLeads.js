import mongoose from 'mongoose';
import { config } from '../src/config/config.js';
import User from '../src/modules/user/user.model.js';
import Lead from '../src/modules/lead/lead.model.js';
import { Order } from '../src/modules/shiprocket/models/order.model.js';
import { ShipmaxxOrder } from '../src/modules/shipmaxx/models/shipmaxxOrder.model.js';
import Verification from '../src/modules/verification/verification.model.js';

async function checkManagerData() {
  try {
    await mongoose.connect(config.mongoose.url, config.mongoose.options);
    const users = await User.find({}).select('_id name role').lean();
    const managerIds = users.filter(u => ['manager', 'logistics', 'admin'].includes(u.role)).map(u => u._id);
    const managerStrSet = new Set(managerIds.map(String));

    console.log(`Checking data for ${managerIds.length} Manager/Logistics/Admin users:`, users.filter(u => ['manager', 'logistics', 'admin'].includes(u.role)).map(u => `${u.name} (${u.role})`));

    const managerLeads = await Lead.countDocuments({ assignedTo: { $in: managerIds } });
    console.log(`Leads assigned to Manager/Logistics/Admin: ${managerLeads}`);

    const managerVerifs = await Verification.countDocuments({ 
      $or: [{ assignedTo: { $in: managerIds } }, { verifiedBy: { $in: managerIds } }] 
    });
    console.log(`Verifications linked to Manager/Logistics/Admin: ${managerVerifs}`);

    const managerSROrders = await Order.countDocuments({
      $or: [
        { created_by: { $in: managerIds } },
        { task_created_by: { $in: managerIds } },
        { verified_by: { $in: managerIds } }
      ]
    });
    console.log(`Shiprocket Orders linked to Manager/Logistics/Admin: ${managerSROrders}`);

    const managerSMOrders = await ShipmaxxOrder.countDocuments({
      $or: [
        { created_by: { $in: managerIds } },
        { task_created_by: { $in: managerIds } },
        { verified_by: { $in: managerIds } }
      ]
    });
    console.log(`Shipmaxx Orders linked to Manager/Logistics/Admin: ${managerSMOrders}`);

    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

checkManagerData();

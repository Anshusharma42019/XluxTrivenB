import mongoose from 'mongoose';
import { config } from '../src/config/config.js';
import User from '../src/modules/user/user.model.js';
import Lead from '../src/modules/lead/lead.model.js';
import { Order } from '../src/modules/shiprocket/models/order.model.js';
import { ShipmaxxOrder } from '../src/modules/shipmaxx/models/shipmaxxOrder.model.js';
import Verification from '../src/modules/verification/verification.model.js';

async function runReattribution() {
  try {
    console.log('Connecting to database...');
    await mongoose.connect(config.mongoose.url, config.mongoose.options);
    console.log('Database connected successfully.');

    // 1. Fetch all users and identify Manager / Logistics / Admin users
    const users = await User.find({}).select('_id name role department').lean();
    const userRoleMap = new Map();
    const managerLogisticsIds = [];

    for (const u of users) {
      const sId = String(u._id);
      userRoleMap.set(sId, u.role);
      if (['manager', 'logistics', 'admin'].includes(u.role)) {
        managerLogisticsIds.push(u._id);
      }
    }

    console.log(`Found ${users.length} total users. ${managerLogisticsIds.length} are Manager/Logistics/Admin.`);

    if (managerLogisticsIds.length === 0) {
      console.log('No Manager/Logistics users found. Exiting.');
      process.exit(0);
    }

    // 2. Query target orders that need fix
    const query = {
      $or: [
        { verified_by: { $in: managerLogisticsIds } },
        { created_by: { $in: managerLogisticsIds } },
        { task_created_by: { $in: managerLogisticsIds } }
      ]
    };

    const targetSR = await Order.find(query)
      .select('_id billing_phone lead_id created_by task_created_by verified_by verification_id')
      .populate('lead_id', 'assignedTo phone')
      .lean();

    const targetSM = await ShipmaxxOrder.find(query)
      .select('_id billing_phone lead_id created_by task_created_by verified_by verification_id')
      .populate('lead_id', 'assignedTo phone')
      .lean();

    console.log(`Found ${targetSR.length} Shiprocket orders & ${targetSM.length} Shipmaxx orders to re-attribute.`);

    // 3. Gather phone numbers needed for lookup
    const allPhones = new Set();
    for (const o of [...targetSR, ...targetSM]) {
      const phone = (o.billing_phone || (o.lead_id && o.lead_id.phone))?.replace(/\D/g, '').slice(-10);
      if (phone && phone.length >= 10) allPhones.add(phone);
    }

    console.log(`Looking up phone-to-sales mapping for ${allPhones.size} unique customer phone numbers...`);

    const phoneToSalesMap = new Map();
    if (allPhones.size > 0) {
      const phoneList = Array.from(allPhones);
      const phoneRegexes = phoneList.flatMap(p => [p, `91${p}`, `+91${p}`, `0${p}`]);
      const matchedLeads = await Lead.find({ phone: { $in: phoneRegexes }, assignedTo: { $ne: null } })
        .select('phone assignedTo')
        .lean();

      for (const l of matchedLeads) {
        if (!l.assignedTo) continue;
        const role = userRoleMap.get(String(l.assignedTo));
        if (['sales', 'support'].includes(role)) {
          const cleanP = String(l.phone).replace(/\D/g, '').slice(-10);
          if (cleanP && !phoneToSalesMap.has(cleanP)) {
            phoneToSalesMap.set(cleanP, String(l.assignedTo));
          }
        }
      }
    }

    console.log(`Mapped ${phoneToSalesMap.size} phone numbers to Sales/Support agents.`);

    const managerStrSet = new Set(managerLogisticsIds.map(String));

    const getBestAgent = (o) => {
      if (o.lead_id && o.lead_id.assignedTo) {
        const role = userRoleMap.get(String(o.lead_id.assignedTo));
        if (['sales', 'support'].includes(role)) return String(o.lead_id.assignedTo);
      }
      const phone = (o.billing_phone || (o.lead_id && o.lead_id.phone))?.replace(/\D/g, '').slice(-10);
      if (phone && phoneToSalesMap.has(phone)) {
        return phoneToSalesMap.get(phone);
      }
      for (const fId of [o.task_created_by, o.verified_by, o.created_by].filter(Boolean).map(String)) {
        if (!managerStrSet.has(fId) && ['sales', 'support'].includes(userRoleMap.get(fId))) {
          return fId;
        }
      }
      return null;
    };

    // 4. Bulk Update Shiprocket orders
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
    console.log(`Bulk updated ${srOps.length} Shiprocket orders.`);

    // 5. Bulk Update Shipmaxx orders
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
    console.log(`Bulk updated ${smOps.length} Shipmaxx orders.`);

    // 6. Bulk Update Verification records
    const targetVerifs = await Verification.find({ verifiedBy: { $in: managerLogisticsIds } })
      .select('_id assignedTo lead verifiedBy')
      .populate('lead', 'assignedTo')
      .lean();

    const verifOps = [];
    for (const v of targetVerifs) {
      let agentId = null;
      if (v.assignedTo) {
        const role = userRoleMap.get(String(v.assignedTo));
        if (['sales', 'support'].includes(role)) agentId = String(v.assignedTo);
      }
      if (!agentId && v.lead && v.lead.assignedTo) {
        const role = userRoleMap.get(String(v.lead.assignedTo));
        if (['sales', 'support'].includes(role)) agentId = String(v.lead.assignedTo);
      }
      if (agentId) {
        verifOps.push({ updateOne: { filter: { _id: v._id }, update: { $set: { verifiedBy: new mongoose.Types.ObjectId(agentId) } } } });
      }
    }
    if (verifOps.length > 0) {
      await Verification.bulkWrite(verifOps);
    }
    console.log(`Bulk updated ${verifOps.length} Verification records.`);

    console.log('🎉 ALL DATABASE RECORDS REATTRIBUTED SUCCESSFULLY!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Script failed with error:', err);
    process.exit(1);
  }
}

runReattribution();

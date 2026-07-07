import 'dotenv/config';
import mongoose from 'mongoose';
import { Order } from './src/modules/shiprocket/models/order.model.js';
import { ShipmaxxOrder } from './src/modules/shipmaxx/models/shipmaxxOrder.model.js';
import Lead from './src/modules/lead/lead.model.js';

await mongoose.connect(process.env.MONGODB_URL);

const monthStart = new Date(Date.UTC(2026, 6, 1) - (5.5 * 60 * 60 * 1000));
const monthEnd = new Date(Date.UTC(2026, 7, 0, 23, 59, 59, 999) - (5.5 * 60 * 60 * 1000));

// Find all old leads
const oldLeads = await Lead.find({ 
    $or: [
        { status: 'old' },
        { pending_reorder_source: { $exists: true, $ne: null } }
    ],
    isDeleted: { $ne: true }
}).distinct('_id');

const q_old_leads = {
  source_order_id: null,
  status: { $in: ['DELIVERED', 'Delivered', 'delivered'] },
  $and: [
    { $or: [{ lead_id: { $in: oldLeads } }] },
    { $or: [
        { delivered_at: { $gte: monthStart, $lte: monthEnd } },
        { delivered_at: null, status_updated_at: { $gte: monthStart, $lte: monthEnd } },
        { delivered_at: null, status_updated_at: null, createdAt: { $gte: monthStart, $lte: monthEnd } },
      ]
    }
  ]
};

const sr_old = await Order.countDocuments(q_old_leads);
const sm_old = await ShipmaxxOrder.countDocuments(q_old_leads);

console.log("Total '2kit' (old patient) orders delivered this month:", sr_old + sm_old);

process.exit(0);

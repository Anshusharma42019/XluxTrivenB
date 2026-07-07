import 'dotenv/config';
import mongoose from 'mongoose';
import { Order } from './src/modules/shiprocket/models/order.model.js';
import { ShipmaxxOrder } from './src/modules/shipmaxx/models/shipmaxxOrder.model.js';
import Lead from './src/modules/lead/lead.model.js';

await mongoose.connect(process.env.MONGODB_URL);

const allOrders = await Order.find({ source_order_id: null }).select('_id lead_id createdAt').sort({ createdAt: 1 }).lean();
const allSmOrders = await ShipmaxxOrder.find({ source_order_id: null }).select('_id lead_id createdAt').sort({ createdAt: 1 }).lean();
const combinedOrders = [...allOrders, ...allSmOrders].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

const oldLeads = await Lead.find({ 
    $or: [
        { status: 'old' },
        { pending_reorder_source: { $exists: true, $ne: null } }
    ],
    isDeleted: { $ne: true }
}).distinct('_id');
const oldLeadsSet = new Set(oldLeads.map(id => String(id)));

const leadOrderCount = {};
const secondKitOrderIds = [];
for (const oc of combinedOrders) {
    if (!oc.lead_id) continue;
    const lId = String(oc.lead_id);
    if (!leadOrderCount[lId]) leadOrderCount[lId] = 0;
    leadOrderCount[lId]++;
    
    // If it's physically >= 2nd order OR the lead is marked as 'old'/reorder and it's their 1st order in the DB
    if (leadOrderCount[lId] >= 2 || (leadOrderCount[lId] === 1 && oldLeadsSet.has(lId))) {
        secondKitOrderIds.push(oc._id);
    }
}

const monthStart = new Date(Date.UTC(2026, 6, 1) - (5.5 * 60 * 60 * 1000));
const monthEnd = new Date(Date.UTC(2026, 7, 0, 23, 59, 59, 999) - (5.5 * 60 * 60 * 1000));

const deliveredCount = await Order.countDocuments({
    _id: { $in: secondKitOrderIds },
    status: { $in: ['DELIVERED', 'Delivered', 'delivered'] },
    $or: [
        { delivered_at: { $gte: monthStart, $lte: monthEnd } },
        { delivered_at: null, status_updated_at: { $gte: monthStart, $lte: monthEnd } },
        { delivered_at: null, status_updated_at: null, createdAt: { $gte: monthStart, $lte: monthEnd } },
    ]
});

const smDeliveredCount = await ShipmaxxOrder.countDocuments({
    _id: { $in: secondKitOrderIds },
    status: { $in: ['DELIVERED', 'Delivered', 'delivered'] },
    $or: [
        { delivered_at: { $gte: monthStart, $lte: monthEnd } },
        { delivered_at: null, status_updated_at: { $gte: monthStart, $lte: monthEnd } },
        { delivered_at: null, status_updated_at: null, createdAt: { $gte: monthStart, $lte: monthEnd } },
    ]
});

console.log("Total 2kit orders delivered this month:", deliveredCount + smDeliveredCount);

process.exit(0);

import 'dotenv/config';
import mongoose from 'mongoose';
import { Order } from './src/modules/shiprocket/models/order.model.js';
import { ShipmaxxOrder } from './src/modules/shipmaxx/models/shipmaxxOrder.model.js';
import Lead from './src/modules/lead/lead.model.js';

await mongoose.connect(process.env.MONGODB_URL);

const monthStart = new Date(Date.UTC(2026, 6, 1) - (5.5 * 60 * 60 * 1000));
const monthEnd = new Date(Date.UTC(2026, 7, 0, 23, 59, 59, 999) - (5.5 * 60 * 60 * 1000));

// Find all deliveries this month
const srOrders = await Order.find({ 
    status: { $in: ['DELIVERED', 'Delivered', 'delivered'] },
    source_order_id: null
}).lean();
const smOrders = await ShipmaxxOrder.find({ 
    status: { $in: ['DELIVERED', 'Delivered', 'delivered'] },
    source_order_id: null
}).lean();

const allDelivered = [...srOrders, ...smOrders].filter(o => {
    const dt = new Date(o.delivered_at || o.status_updated_at || o.createdAt);
    return dt >= monthStart && dt <= monthEnd;
});

// We need to calculate kit number for these.
// A kit number is the sequential order of the order for that lead.
// Let's get all orders for all leads involved
const leadIds = allDelivered.map(o => o.lead_id).filter(Boolean);
const allOrdersForLeads = await Order.find({ lead_id: { $in: leadIds } })
    .select('_id lead_id createdAt')
    .sort({ createdAt: 1 })
    .lean();
    
const allSmOrdersForLeads = await ShipmaxxOrder.find({ lead_id: { $in: leadIds } })
    .select('_id lead_id createdAt')
    .sort({ createdAt: 1 })
    .lean();
    
const combinedOrders = [...allOrdersForLeads, ...allSmOrdersForLeads].sort((a,b) => new Date(a.createdAt) - new Date(b.createdAt));

const seqMap = {};
const leadOrderCount = {};
for (const oc of combinedOrders) {
    const lId = String(oc.lead_id);
    if (!leadOrderCount[lId]) leadOrderCount[lId] = 0;
    leadOrderCount[lId]++;
    seqMap[String(oc._id)] = leadOrderCount[lId];
}

let count2Kit = 0;
let count3Kit = 0;

allDelivered.forEach(o => {
    const kitNumber = seqMap[String(o._id)] || 1;
    if (kitNumber === 2) count2Kit++;
    if (kitNumber >= 2) count3Kit++; // 2 or more
});

console.log("Total deliveries this month:", allDelivered.length);
console.log("Total 2-kit deliveries this month:", count2Kit);
console.log("Total 2nd-kit-or-higher deliveries this month:", count3Kit);

process.exit(0);

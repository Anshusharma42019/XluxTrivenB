import 'dotenv/config';
import mongoose from 'mongoose';
import { Order } from './src/modules/shiprocket/models/order.model.js';
import { ShipmaxxOrder } from './src/modules/shipmaxx/models/shipmaxxOrder.model.js';
import Lead from './src/modules/lead/lead.model.js';

await mongoose.connect(process.env.MONGODB_URL);

const userId = '69e347cbccb980c705fc580e'; // Srishti

const monthStart = new Date(Date.UTC(2026, 6, 1) - (5.5 * 60 * 60 * 1000));
const monthEnd = new Date(Date.UTC(2026, 7, 0, 23, 59, 59, 999) - (5.5 * 60 * 60 * 1000));

const staffLeads = await Lead.find({ assignedTo: userId, isDeleted: { $ne: true } }).distinct('_id');

// Let's get ALL delivered orders assigned to Srishti's leads this month
const srOrders = await Order.find({ 
    lead_id: { $in: staffLeads }, 
    status: { $in: ['DELIVERED', 'Delivered', 'delivered'] } 
}).lean();

const smOrders = await ShipmaxxOrder.find({ 
    lead_id: { $in: staffLeads }, 
    status: { $in: ['DELIVERED', 'Delivered', 'delivered'] } 
}).lean();

const allDelivered = [...srOrders, ...smOrders].filter(o => {
  const dt = new Date(o.delivered_at || o.status_updated_at || o.createdAt);
  return dt >= monthStart && dt <= monthEnd;
});

console.log("All delivered (regardless of source_order_id):", allDelivered.length);
let countKit2 = 0;
let countNullSource = 0;
allDelivered.forEach(o => {
   console.log(`Order ID: ${o._id}, kit_number: ${o.kit_number}, source_order_id: ${o.source_order_id}`);
   if (o.kit_number === 2) countKit2++;
   if (o.source_order_id === null) countNullSource++;
});

console.log("Kit 2 count:", countKit2);
console.log("Null source count:", countNullSource);

process.exit(0);

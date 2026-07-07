import 'dotenv/config';
import mongoose from 'mongoose';
import { Order } from './src/modules/shiprocket/models/order.model.js';
import { ShipmaxxOrder } from './src/modules/shipmaxx/models/shipmaxxOrder.model.js';
import Lead from './src/modules/lead/lead.model.js';
import User from './src/modules/user/user.model.js';

await mongoose.connect(process.env.MONGODB_URL);

const srOrders = await Order.find({ status: { $in: ['DELIVERED', 'Delivered', 'delivered'] }}).lean();
const smOrders = await ShipmaxxOrder.find({ status: { $in: ['DELIVERED', 'Delivered', 'delivered'] }}).lean();
const allDelivered = [...srOrders, ...smOrders];

let kits = {};
let kit2Count = 0;
allDelivered.forEach(o => {
    let kit = o.kit_number;
    
    // Some might not have kit_number but we can deduce from items?
    let has2KitItem = false;
    if (o.order_items && Array.isArray(o.order_items)) {
        has2KitItem = o.order_items.some(i => i.name && i.name.toLowerCase().includes('2 kit'));
    }

    if (kit === 2 || has2KitItem) {
        kit2Count++;
    }
});

console.log("Total Delivered:", allDelivered.length);
console.log("Total 2-kit Delivered:", kit2Count);

const sr_all_verified = await Order.countDocuments({ verified_by: '69e347cbccb980c705fc580e', status: { $in: ['DELIVERED', 'Delivered', 'delivered'] }});
const sm_all_verified = await ShipmaxxOrder.countDocuments({ verified_by: '69e347cbccb980c705fc580e', status: { $in: ['DELIVERED', 'Delivered', 'delivered'] }});
console.log("Srishti verified ALL time deliveries:", sr_all_verified + sm_all_verified);

process.exit(0);

import 'dotenv/config';
import mongoose from 'mongoose';
import { Order } from './src/modules/shiprocket/models/order.model.js';
import { ShipmaxxOrder } from './src/modules/shipmaxx/models/shipmaxxOrder.model.js';

await mongoose.connect(process.env.MONGODB_URL);

const sr_not_null = await Order.countDocuments({ source_order_id: { $ne: null }, status: { $in: ['DELIVERED', 'Delivered', 'delivered'] } });
const sm_not_null = await ShipmaxxOrder.countDocuments({ source_order_id: { $ne: null }, status: { $in: ['DELIVERED', 'Delivered', 'delivered'] } });

console.log("Delivered orders with source_order_id != null:", sr_not_null + sm_not_null);

const sr_not_null_this_month = await Order.countDocuments({ 
    source_order_id: { $ne: null }, 
    status: { $in: ['DELIVERED', 'Delivered', 'delivered'] },
    delivered_at: { $gte: new Date(Date.UTC(2026, 6, 1) - (5.5 * 60 * 60 * 1000)) }
});
console.log("This month:", sr_not_null_this_month);

process.exit(0);

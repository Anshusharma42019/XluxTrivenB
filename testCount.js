import 'dotenv/config';
import mongoose from 'mongoose';
import { Order } from './src/modules/shiprocket/models/order.model.js';
import { ShipmaxxOrder } from './src/modules/shipmaxx/models/shipmaxxOrder.model.js';
import Lead from './src/modules/lead/lead.model.js';

await mongoose.connect(process.env.MONGODB_URL);
const orders = await Order.find({ status: { $in: ['DELIVERED', 'Delivered', 'delivered'] }}).lean();
const names = [...new Set(orders.flatMap(o => o.order_items.map(i => i.name)))];
console.log(names);
process.exit(0);

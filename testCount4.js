import 'dotenv/config';
import mongoose from 'mongoose';
import { Order } from './src/modules/shiprocket/models/order.model.js';
import { ShipmaxxOrder } from './src/modules/shipmaxx/models/shipmaxxOrder.model.js';

await mongoose.connect(process.env.MONGODB_URL);

const srOrders = await Order.find({ status: { $in: ['DELIVERED', 'Delivered', 'delivered'] }}).lean();
const smOrders = await ShipmaxxOrder.find({ status: { $in: ['DELIVERED', 'Delivered', 'delivered'] }}).lean();
const allDelivered = [...srOrders, ...smOrders];

let twoItemsCount = 0;
let twoUnitsCount = 0;

allDelivered.forEach(o => {
    if (o.order_items && o.order_items.length === 2) twoItemsCount++;
    if (o.order_items && o.order_items.reduce((acc, i) => acc + (i.units || 1), 0) === 2) twoUnitsCount++;
});

console.log("Total Delivered:", allDelivered.length);
console.log("Orders with 2 items:", twoItemsCount);
console.log("Orders with 2 units total:", twoUnitsCount);

process.exit(0);

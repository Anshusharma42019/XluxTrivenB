import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { Order } from '../src/modules/shiprocket/models/order.model.js';

dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGODB_URL);
  try {
    const orders = await Order.find({ platform: 'shipmaxx' }).sort({ createdAt: -1 }).limit(10).lean();
    console.log('Recent ShipMaxx Orders in DB:', JSON.stringify(orders, null, 2));
    
    const stats = await Order.aggregate([
      { $match: { platform: 'shipmaxx' } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);
    console.log('All Shipmaxx Statuses:', JSON.stringify(stats, null, 2));

  } catch (err) {
    console.error('Error:', err.message);
  }
  mongoose.disconnect();
}
run();

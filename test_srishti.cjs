import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import Order from './src/modules/shiprocket/models/order.model.js';
import ShipmaxxOrder from './src/modules/shipmaxx/models/shipmaxxOrder.model.js';
import User from './src/modules/user/user.model.js';

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  
  const user = await User.findOne({ name: /Srishti Chauhan/i });
  console.log('User:', user.name, user.role, user._id);
  
  const monthStart = new Date('2026-07-01T00:00:00.000Z');
  const monthEnd = new Date('2026-07-31T23:59:59.999Z');
  
  const q = {
    source_order_id: null,
    status: { $in: ['DELIVERED', 'Delivered', 'delivered'] },
    $and: [
      { created_by: user._id },
      { $or: [
          { delivered_at: { $gte: monthStart, $lte: monthEnd } },
          { delivered_at: null, status_updated_at: { $gte: monthStart, $lte: monthEnd } },
          { delivered_at: null, status_updated_at: null, createdAt: { $gte: monthStart, $lte: monthEnd } },
        ]
      }
    ]
  };
  const count1 = await Order.countDocuments(q);
  const count2 = await ShipmaxxOrder.countDocuments(q);
  console.log('Created by Srishti:', count1 + count2);
  
  process.exit(0);
}
run();

import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  const uri = process.env.MONGODB_URL || process.env.MONGO_URI;
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  
  const orders = await db.collection('shipmaxxorders').find({ platform: 'shipmaxx' }).sort({ createdAt: -1 }).limit(10).toArray();
  for (const o of orders) {
    console.log({
      id: o.order_id,
      status: o.status,
      status_updated_at: o.status_updated_at,
      delivered_at: o.delivered_at,
      createdAt: o.createdAt
    });
  }
  process.exit(0);
}
run();

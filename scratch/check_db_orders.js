import 'dotenv/config';
import mongoose from 'mongoose';

async function check() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const orders = await db.collection('shipmaxxorders').find({
    order_id: { $in: ['33317', '32307', '31666', '32279'] }
  }).toArray();
  
  for (const o of orders) {
    console.log(`Order ${o.order_id}:`);
    console.log(`  createdAt: ${o.createdAt}`);
    console.log(`  status_updated_at: ${o.status_updated_at}`);
    console.log(`  delivered_at: ${o.delivered_at}`);
    console.log(`  raw_response (partial): ${JSON.stringify(o.raw_response?.history || o.raw_response?.tracking_data || 'None').substring(0, 200)}`);
  }
  process.exit(0);
}
check();

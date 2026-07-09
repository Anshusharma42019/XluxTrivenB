import 'dotenv/config';
import mongoose from 'mongoose';

await mongoose.connect(process.env.MONGODB_URL);
const db = mongoose.connection.db;

const monthStart = new Date('2026-07-01T00:00:00.000+05:30');
const monthEnd = new Date('2026-07-31T23:59:59.999+05:30');
const statuses = ['DELIVERED', 'Delivered', 'delivered'];

const orders = await db.collection('shipmaxxorders').find({
  status: { $in: statuses },
  delivered_at: null,
  status_updated_at: { $gte: monthStart, $lte: monthEnd }
}).project({ order_id: 1, status: 1, createdAt: 1, status_updated_at: 1, delivered_at: 1 }).toArray();

console.log(`Total: ${orders.length}`);
for (const o of orders) {
  console.log(`order_id: ${o.order_id} | createdAt: ${o.createdAt?.toISOString().slice(0,10)} | status_updated_at: ${o.status_updated_at?.toISOString().slice(0,10)} | delivered_at: ${o.delivered_at}`);
}

process.exit(0);

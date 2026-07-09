import 'dotenv/config';
import mongoose from 'mongoose';

await mongoose.connect(process.env.MONGODB_URL);
const db = mongoose.connection.db;

const monthStart = new Date('2026-07-01T00:00:00.000+05:30');
const monthEnd = new Date('2026-07-31T23:59:59.999+05:30');
const statuses = ['DELIVERED', 'Delivered', 'delivered'];

for (const col of ['orders', 'shipmaxxorders']) {
  const c = db.collection(col);

  const byDeliveredAt = await c.countDocuments({ status: { $in: statuses }, delivered_at: { $gte: monthStart, $lte: monthEnd } });
  const byStatusUpdatedAt = await c.countDocuments({ status: { $in: statuses }, delivered_at: null, status_updated_at: { $gte: monthStart, $lte: monthEnd } });
  const byCreatedAt = await c.countDocuments({ status: { $in: statuses }, delivered_at: null, status_updated_at: null, createdAt: { $gte: monthStart, $lte: monthEnd } });
  const total = await c.countDocuments({ status: { $in: statuses }, $or: [
    { delivered_at: { $gte: monthStart, $lte: monthEnd } },
    { delivered_at: null, status_updated_at: { $gte: monthStart, $lte: monthEnd } },
    { delivered_at: null, status_updated_at: null, createdAt: { $gte: monthStart, $lte: monthEnd } },
  ]});

  console.log(`\n[${col}]`);
  console.log(`  by delivered_at:      ${byDeliveredAt}`);
  console.log(`  by status_updated_at: ${byStatusUpdatedAt}`);
  console.log(`  by createdAt:         ${byCreatedAt}`);
  console.log(`  TOTAL (old logic):    ${total}`);
}

process.exit(0);

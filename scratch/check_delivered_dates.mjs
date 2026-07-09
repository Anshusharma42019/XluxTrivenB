import 'dotenv/config';
import mongoose from 'mongoose';

await mongoose.connect(process.env.MONGODB_URL);
const db = mongoose.connection.db;

const monthStart = new Date('2026-07-01T00:00:00.000+05:30');
const monthEnd = new Date('2026-07-31T23:59:59.999+05:30');
const statuses = ['DELIVERED', 'Delivered', 'delivered'];

// Check if any of the 88 have delivered_at outside July in IST
const orders = await db.collection('shipmaxxorders').find({
  status: { $in: statuses },
  delivered_at: { $gte: monthStart, $lte: monthEnd }
}).project({ order_id: 1, delivered_at: 1 }).toArray();

// Group by IST date
const dateCounts = {};
for (const o of orders) {
  const ist = new Date(new Date(o.delivered_at).getTime() + 5.5 * 60 * 60 * 1000);
  const dateStr = ist.toISOString().slice(0, 10);
  dateCounts[dateStr] = (dateCounts[dateStr] || 0) + 1;
}

console.log('Delivered orders by IST date:');
for (const [d, c] of Object.entries(dateCounts).sort()) {
  console.log(`  ${d}: ${c}`);
}
console.log(`Total: ${orders.length}`);

process.exit(0);

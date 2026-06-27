import mongoose from 'mongoose';
import dotenv from 'dotenv'; dotenv.config({ path: '.env' });

mongoose.connect(process.env.MONGODB_URL).then(async () => {
  const db = mongoose.connection.db;
  
  const today = new Date('2026-06-27T00:00:00.000+05:30');
  const endOfDay = new Date('2026-06-27T23:59:59.999+05:30');

  const ordersToday = await db.collection('shipmaxxorders').find({
    platform: 'shipmaxx',
    createdAt: { $gte: today, $lte: endOfDay }
  }).toArray();

  console.log(`Total Shipmaxx orders with createdAt = TODAY: ${ordersToday.length}`);
  
  if (ordersToday.length > 0) {
    console.log(ordersToday.slice(0, 3).map(o => ({
      order_id: o.order_id,
      createdAt: o.createdAt,
      status: o.status
    })));
  }

  process.exit(0);
});

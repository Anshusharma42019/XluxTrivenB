import mongoose from 'mongoose';
import dotenv from 'dotenv'; dotenv.config({ path: '.env' });

mongoose.connect(process.env.MONGODB_URL).then(async () => {
  const db = mongoose.connection.db;
  
  const today = new Date('2026-06-27T00:00:00.000+05:30');
  const endOfDay = new Date('2026-06-27T23:59:59.999+05:30');

  const ordersToday = await db.collection('shipmaxxorders').find({
    platform: 'shipmaxx',
    createdAt: { $gte: today, $lte: endOfDay },
    status: 'DELIVERED'
  }).toArray();

  console.log(`Total delivered today: ${ordersToday.length}`);
  if (ordersToday.length > 0) {
    console.log(ordersToday.slice(0, 3).map(o => ({
      order_id: o.order_id,
      createdAt: o.createdAt,
      status_updated_at: o.status_updated_at
    })));
  }

  process.exit(0);
});

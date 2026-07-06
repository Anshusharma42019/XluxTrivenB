import { config } from './src/config/config.js';
import mongoose from 'mongoose';

console.log('Connecting to DB...');

mongoose.connect(config.mongoose.url, config.mongoose.options).then(async () => {
  const db = mongoose.connection.db;
  
  // Count all ShipMaxx orders
  const total = await db.collection('shipmaxxorders').countDocuments({ platform: 'shipmaxx' });
  console.log('Total ShipMaxx orders in DB:', total);
  
  // Count all orders (regardless of platform)
  const totalAll = await db.collection('shipmaxxorders').countDocuments({});
  console.log('Total orders in shipmaxxorders collection:', totalAll);

  // Get status breakdown
  const breakdown = await db.collection('shipmaxxorders').aggregate([
    { $match: { platform: 'shipmaxx' } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
    { $sort: { count: -1 } }
  ]).toArray();
  console.log('\nStatus breakdown:');
  breakdown.forEach(b => console.log(`  ${b._id}: ${b.count}`));

  // Check today's data  
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayCount = await db.collection('shipmaxxorders').countDocuments({
    platform: 'shipmaxx',
    status_updated_at: { $gte: todayStart }
  });
  console.log('\nOrders with status_updated_at today:', todayCount);

  // Sample 3 orders
  const samples = await db.collection('shipmaxxorders').find({ platform: 'shipmaxx' }).sort({ status_updated_at: -1 }).limit(3).toArray();
  console.log('\nSample recent orders:');
  samples.forEach(s => console.log(`  order_id=${s.order_id} status=${s.status} awb=${s.awb_code} updated=${s.status_updated_at} created=${s.createdAt}`));

  // Check env vars
  console.log('\nSHIPMAXX_EMAIL:', process.env.SHIPMAXX_EMAIL ? 'SET' : 'NOT SET');
  console.log('SHIPMAXX_PASSWORD:', process.env.SHIPMAXX_PASSWORD ? 'SET' : 'NOT SET');
  console.log('SHIPMAXX_BASE_URL:', process.env.SHIPMAXX_BASE_URL || '(using default)');

  process.exit(0);
}).catch(e => {
  console.error('DB connection failed:', e.message);
  process.exit(1);
});

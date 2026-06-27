import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config({ path: '.env' });

async function check() {
  await mongoose.connect(process.env.MONGODB_URL);
  const db = mongoose.connection.db;
  
  const total = await db.collection('shipmaxxorders').countDocuments({ platform: 'shipmaxx' });
  const junePlaced = await db.collection('shipmaxxorders').countDocuments({ platform: 'shipmaxx', createdAt: { $gte: new Date('2026-06-01T00:00:00.000+05:30'), $lte: new Date('2026-06-30T23:59:59.999+05:30') } });
  
  const statuses = await db.collection('shipmaxxorders').aggregate([
    { $match: { platform: 'shipmaxx' } },
    { $group: { _id: '$status', count: { $sum: 1 } } }
  ]).toArray();

  console.log('Total Shipmaxx orders:', total);
  console.log('Total Placed in June:', junePlaced);
  console.log('Statuses:', statuses);
  process.exit();
}
check().catch(console.error);

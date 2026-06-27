import mongoose from 'mongoose';
import dotenv from 'dotenv'; dotenv.config({ path: '.env' });

mongoose.connect(process.env.MONGODB_URL).then(async () => {
  const db = mongoose.connection.db;
  const counts = await db.collection('shipmaxxorders').aggregate([
    { $match: { platform: 'shipmaxx', status: 'DELIVERED' } },
    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$status_updated_at' } }, count: { $sum: 1 } } }
  ]).toArray();
  
  const createdCounts = await db.collection('shipmaxxorders').aggregate([
    { $match: { platform: 'shipmaxx', status: 'DELIVERED' } },
    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } }
  ]).toArray();
  
  console.log('Status Updated Dates:', counts);
  console.log('Created Dates:', createdCounts.slice(0, 5));
  process.exit();
});

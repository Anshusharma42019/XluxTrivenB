import mongoose from 'mongoose';
import dotenv from 'dotenv'; dotenv.config({ path: '.env' });

mongoose.connect(process.env.MONGODB_URL).then(async () => {
  const db = mongoose.connection.db;
  
  const from = new Date('2026-06-01T00:00:00.000+05:30');
  const to = new Date('2026-06-30T23:59:59.999+05:30');

  const countByCreated = await db.collection('shipmaxxorders').countDocuments({
    platform: 'shipmaxx',
    createdAt: { $gte: from, $lte: to }
  });

  const countByStatusUpdated = await db.collection('shipmaxxorders').countDocuments({
    platform: 'shipmaxx',
    status_updated_at: { $gte: from, $lte: to }
  });
  
  const countAll = await db.collection('shipmaxxorders').countDocuments({
    platform: 'shipmaxx'
  });

  console.log({ countByCreated, countByStatusUpdated, countAll });
  process.exit(0);
});

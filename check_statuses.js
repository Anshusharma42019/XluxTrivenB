import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/xluxtech');
  const db = mongoose.connection.db;
  
  const srStatuses = await db.collection('shiprocketorders').aggregate([
    { $group: { _id: { status: '$status', platform: '$platform' }, count: { $sum: 1 } } },
    { $sort: { count: -1 } }
  ]).toArray();
  
  console.log('Statuses in shiprocketorders collection:', JSON.stringify(srStatuses, null, 2));

  process.exit(0);
}
run();

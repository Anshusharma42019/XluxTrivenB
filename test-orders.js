import 'dotenv/config';
import connectDB from './src/config/database.js';
import mongoose from 'mongoose';

async function run() {
  await connectDB();
  const db = mongoose.connection.db;
  const count77 = await db.collection('orders').countDocuments({ awb_code: { $regex: '^77' } });
  const countSF = await db.collection('orders').countDocuments({ awb_code: { $regex: '^SF' } });
  const sample77 = await db.collection('orders').findOne({ awb_code: { $regex: '^77' } });
  console.log('Orders with 77:', count77, 'Orders with SF:', countSF);
  console.log('Sample 77 order:', sample77 ? sample77.order_id : 'none');
  process.exit(0);
}
run();

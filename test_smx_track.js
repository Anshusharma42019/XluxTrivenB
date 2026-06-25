import dotenv from 'dotenv';
import smxService from './src/modules/shipmaxx/shipmaxx.service.js';
import mongoose from 'mongoose';
import { Order } from './src/modules/shiprocket/models/order.model.js';

dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGODB_URL);
  try {
    await smxService.login();
    const trackRes = await smxService.trackShipment('152994140008493');
    console.log('Track Res:', JSON.stringify(trackRes, null, 2));
    
    const dbOrder = await Order.findOne({ awb_code: '152994140008493' }).lean();
    console.log('DB Order:', JSON.stringify(dbOrder, null, 2));

  } catch (err) {
    console.error('Error:', err.message);
  }
  mongoose.disconnect();
}
run();

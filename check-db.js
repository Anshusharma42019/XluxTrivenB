import 'dotenv/config';
import connectDB from './src/config/database.js';
import { Order } from './src/modules/shiprocket/models/order.model.js';

async function checkDb() {
  try {
    await connectDB();
    const orders = await Order.find({ platform: 'shipmaxx' }).lean();
    
    console.log(`Total ShipMaxx orders in DB: ${orders.length}`);
    
    const statusCounts = {};
    for (const o of orders) {
      statusCounts[o.status] = (statusCounts[o.status] || 0) + 1;
    }
    
    console.log('Status breakdown in DB:');
    console.log(statusCounts);
    
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

checkDb();

import 'dotenv/config';
import connectDB from './src/config/database.js';
import { Order } from './src/modules/shiprocket/models/order.model.js';

const smxStatusMap = {
  DEL: 'DELIVERED',
  INT: 'IN_TRANSIT',
  UND: 'UNDELIVERED',
  RTO: 'RTO_DELIVERED',
  OFD: 'OUT_FOR_DELIVERY',
  DEX: 'UNDELIVERED_ATTEMPT_FAILURE',
  SC:  'SHIPPED',
  PCN: 'CANCELED',
  RRA: 'REACHED_AT_DESTINATION_HUB',
  SPD: 'PICKUP_SCHEDULED',
  SPB: 'NEW'
};

async function fixStatuses() {
  try {
    await connectDB();
    console.log('Connected to DB');

    let updatedCount = 0;
    const orders = await Order.find({ platform: 'shipmaxx' });
    
    for (const o of orders) {
      const current = o.status;
      if (smxStatusMap[current]) {
        await Order.updateOne({ _id: o._id }, { $set: { status: smxStatusMap[current] } });
        updatedCount++;
      } else if (current !== current.toUpperCase().replace(/[\s-]+/g, '_')) {
        // Fix formatting of generic statuses
        await Order.updateOne({ _id: o._id }, { $set: { status: current.toUpperCase().replace(/[\s-]+/g, '_') } });
        updatedCount++;
      }
    }
    
    console.log(`Updated ${updatedCount} ShipMaxx orders.`);
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

fixStatuses();

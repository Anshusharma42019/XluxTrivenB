import 'dotenv/config';
import connectDB from './src/config/database.js';
import { ShipmaxxOrder } from './src/modules/shipmaxx/models/shipmaxxOrder.model.js';
import { ShipmaxxRtoOrder } from './src/modules/shipmaxx/models/shipmaxxRtoOrder.model.js';

const smxStatusMap = {
  DEL: 'DELIVERED',
  INT: 'IN_TRANSIT',
  UND: 'UNDELIVERED',
  RTO: 'RTO_DELIVERED',
  OFD: 'OUT_FOR_DELIVERY',
  DEX: 'UNDELIVERED_ATTEMPT_FAILURE',
  SC:  'SHIPPED',
  PCN: 'CANCELED',
  RRA: 'RTO_INITIATED',
  SPD: 'PICKUP_SCHEDULED',
  SPB: 'NEW'
};

async function fixStatuses() {
  try {
    await connectDB();
    for (const [shortcode, fullcode] of Object.entries(smxStatusMap)) {
      const res = await ShipmaxxOrder.updateMany(
        { status: shortcode },
        { $set: { status: fullcode } }
      );
      if (res.modifiedCount > 0) {
        console.log(`Updated ${res.modifiedCount} orders from ${shortcode} to ${fullcode} in ShipmaxxOrder`);
      }
      
      const res2 = await ShipmaxxRtoOrder.updateMany(
        { status: shortcode },
        { $set: { status: fullcode } }
      );
      if (res2.modifiedCount > 0) {
        console.log(`Updated ${res2.modifiedCount} orders from ${shortcode} to ${fullcode} in ShipmaxxRtoOrder`);
      }
    }
    console.log('Database fixed successfully.');
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

fixStatuses();

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { ShipmaxxOrder } from './src/modules/shipmaxx/models/shipmaxxOrder.model.js';
import { ShipmaxxInTransitOrder } from './src/modules/shipmaxx/models/shipmaxxInTransitOrder.model.js';
import { ShipmaxxDeliveredOrder } from './src/modules/shipmaxx/models/shipmaxxDeliveredOrder.model.js';

dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGODB_URL || process.env.MONGO_URI);
  
  // Find an order
  const order = await ShipmaxxOrder.findOne({ platform: 'shipmaxx', status: 'IN_TRANSIT' });
  if (!order) {
    console.log("No order found");
    process.exit(0);
  }
  
  console.log("Original Order ID:", order.order_id);
  
  // Check InTransit
  let it = await ShipmaxxInTransitOrder.findOne({ order_id: order.order_id });
  console.log("Before Update - InTransit:", !!it);
  
  // Update it via findOneAndUpdate to trigger the hook
  await ShipmaxxOrder.findOneAndUpdate({ order_id: order.order_id }, { $set: { status: 'DELIVERED', delivered_at: new Date() } });
  
  // Wait a sec for the async hook to run
  await new Promise(r => setTimeout(r, 1000));
  
  it = await ShipmaxxInTransitOrder.findOne({ order_id: order.order_id });
  let d = await ShipmaxxDeliveredOrder.findOne({ order_id: order.order_id });
  console.log("After Update - InTransit:", !!it);
  console.log("After Update - Delivered:", !!d);
  
  // Revert
  await ShipmaxxOrder.findOneAndUpdate({ order_id: order.order_id }, { $set: { status: 'IN_TRANSIT', delivered_at: null } });
  await new Promise(r => setTimeout(r, 1000));
  
  it = await ShipmaxxInTransitOrder.findOne({ order_id: order.order_id });
  d = await ShipmaxxDeliveredOrder.findOne({ order_id: order.order_id });
  console.log("After Revert - InTransit:", !!it);
  console.log("After Revert - Delivered:", !!d);

  process.exit(0);
}
run();

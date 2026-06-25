const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const Order = require('../src/modules/shiprocket/models/order.model');

async function run() {
  await mongoose.connect(process.env.MONGODB_URL);
  console.log('Connected to DB');

  const smxOrders = await Order.find({ platform: 'shipmaxx' }).sort({ createdAt: -1 }).limit(5);
  
  if (smxOrders.length === 0) {
    console.log('No ShipMaxx orders found in DB.');
  } else {
    console.log(`Found ${smxOrders.length} ShipMaxx orders.`);
    smxOrders.forEach(o => {
      console.log(`Order: ${o.order_id}, channel_id: ${o.channel_id}, pickup_address_id: ${o.pickup_address_id}`);
    });
  }

  mongoose.disconnect();
}

run().catch(console.error);

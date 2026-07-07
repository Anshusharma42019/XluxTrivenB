require('dotenv').config();
require('mongoose').connect(process.env.MONGODB_URL).then(async () => {
  const Order = require('./src/modules/shiprocket/models/order.model.js').default;
  const ShipmaxxOrder = require('./src/modules/shipmaxx/models/shipmaxxOrder.model.js').default;
  const srOrders = await Order.find({ status: { $in: ['DELIVERED', 'Delivered', 'delivered'] }}).lean();
  const smOrders = await ShipmaxxOrder.find({ status: { $in: ['DELIVERED', 'Delivered', 'delivered'] }}).lean();
  
  const allOrders = [...srOrders, ...smOrders];
  
  // Find orders where support team is assigned as lead or something.
  // Wait, Srishti Chauhan user id is 69e347cbccb980c705fc580e
  // Let's check how she has 4 deliveries in the dashboard.
  // The dashboard query for support is:
  // leadOrCreated = [{ lead_id: { $in: staffLeads } }]
  const Lead = require('./src/modules/lead/lead.model.js').default;
  const staffLeads = await Lead.find({ assignedTo: '69e347cbccb980c705fc580e', isDeleted: { $ne: true } }).distinct('_id');
  
  const myOrders = allOrders.filter(o => staffLeads.some(l => l.toString() === o.lead_id?.toString()));
  console.log("My Orders:", myOrders.length);
  for (const o of myOrders) {
    console.log(`Order ID: ${o._id}, Sub_total: ${o.sub_total}, Items: ${JSON.stringify(o.order_items)}`);
  }
  process.exit(0);
});

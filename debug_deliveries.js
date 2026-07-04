import mongoose from 'mongoose';
import { Order } from './src/modules/shiprocket/models/order.model.js';
import { ShipmaxxOrder } from './src/modules/shipmaxx/models/shipmaxxOrder.model.js';
import Lead from './src/modules/lead/lead.model.js';
import User from './src/modules/user/user.model.js';

import dotenv from 'dotenv';
dotenv.config();

mongoose.connect(process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017/xluxtech').then(async () => {
  const month = new Date().getMonth();
  const year = new Date().getFullYear();
  const IST_OFFSET = 5.5 * 60 * 60 * 1000;
  const monthStart = new Date(Date.UTC(year, month, 1) - IST_OFFSET);
  const monthEnd = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999) - IST_OFFSET);

  const allUsers = await User.find({ role: { $in: ['sales', 'manager', 'staff', 'admin'] } }).lean();
  let individualSumSR = 0;
  let individualSumSM = 0;

  for (const user of allUsers) {
    const staffLeads = await Lead.find({ assignedTo: user._id, isDeleted: { $ne: true } }).distinct('_id');
    const deliveryQuerySR = {
      lead_id: { $in: staffLeads },
      source_order_id: null,
      status: { $in: ['DELIVERED', 'Delivered', 'delivered'] },
      $or: [
        { delivered_at: { $gte: monthStart, $lte: monthEnd } },
        { delivered_at: null, status_updated_at: { $gte: monthStart, $lte: monthEnd } },
        { delivered_at: null, status_updated_at: null, createdAt: { $gte: monthStart, $lte: monthEnd } },
      ],
    };
  
    const deliveryQuerySM = {
      source_order_id: null,
      $or: [ { lead_id: { $in: staffLeads } }, { lead_id: null, created_by: user._id } ],
      status: { $in: ['DELIVERED', 'Delivered', 'delivered'] },
      $and: [
        {
          $or: [
            { delivered_at: { $gte: monthStart, $lte: monthEnd } },
            { delivered_at: null, status_updated_at: { $gte: monthStart, $lte: monthEnd } },
            { delivered_at: null, status_updated_at: null, createdAt: { $gte: monthStart, $lte: monthEnd } },
          ]
        }
      ]
    };

    const srCount = await Order.countDocuments(deliveryQuerySR);
    const smCount = await ShipmaxxOrder.countDocuments(deliveryQuerySM);
    individualSumSR += srCount;
    individualSumSM += smCount;
  }

  const allDeliveryQuerySR = {
    source_order_id: null,
    status: { $in: ['DELIVERED', 'Delivered', 'delivered'] },
    $or: [
      { delivered_at: { $gte: monthStart, $lte: monthEnd } },
      { delivered_at: null, status_updated_at: { $gte: monthStart, $lte: monthEnd } },
      { delivered_at: null, status_updated_at: null, createdAt: { $gte: monthStart, $lte: monthEnd } },
    ],
  };

  const allDeliveryQuerySM = {
    source_order_id: null,
    status: { $in: ['DELIVERED', 'Delivered', 'delivered'] },
    $or: [
      { delivered_at: { $gte: monthStart, $lte: monthEnd } },
      { delivered_at: null, status_updated_at: { $gte: monthStart, $lte: monthEnd } },
      { delivered_at: null, status_updated_at: null, createdAt: { $gte: monthStart, $lte: monthEnd } },
    ],
  };

  const totalSR = await Order.countDocuments(allDeliveryQuerySR);
  const totalSM = await ShipmaxxOrder.countDocuments(allDeliveryQuerySM);

  console.log(`Global Total Deliveries: ${totalSR + totalSM} (SR: ${totalSR}, SM: ${totalSM})`);
  console.log(`Sum of Individual Deliveries: ${individualSumSR + individualSumSM} (SR: ${individualSumSR}, SM: ${individualSumSM})`);

  process.exit(0);
}).catch(console.error);

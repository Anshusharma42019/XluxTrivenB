require('dotenv').config();
require('mongoose').connect(process.env.MONGODB_URL).then(async () => {
  const Order = require('./src/modules/shiprocket/models/order.model.js').default;
  const ShipmaxxOrder = require('./src/modules/shipmaxx/models/shipmaxxOrder.model.js').default;
  const Lead = require('./src/modules/lead/lead.model.js').default;

  const userId = '69e347cbccb980c705fc580e'; // Srishti

  // Month bounds (assuming July 2026 based on timestamp)
  const monthStart = new Date(Date.UTC(2026, 6, 1) - (5.5 * 60 * 60 * 1000));
  const monthEnd = new Date(Date.UTC(2026, 7, 0, 23, 59, 59, 999) - (5.5 * 60 * 60 * 1000));

  const staffLeads = await Lead.find({ assignedTo: userId, isDeleted: { $ne: true } }).distinct('_id');

  const q_original = {
    source_order_id: null,
    status: { $in: ['DELIVERED', 'Delivered', 'delivered'] },
    $and: [
      { $or: [{ lead_id: { $in: staffLeads } }] },
      { $or: [
          { delivered_at: { $gte: monthStart, $lte: monthEnd } },
          { delivered_at: null, status_updated_at: { $gte: monthStart, $lte: monthEnd } },
          { delivered_at: null, status_updated_at: null, createdAt: { $gte: monthStart, $lte: monthEnd } },
        ]
      }
    ]
  };

  const q_new = {
    source_order_id: null,
    status: { $in: ['DELIVERED', 'Delivered', 'delivered'] },
    $and: [
      { $or: [{ verified_by: userId }] },
      { $or: [
          { delivered_at: { $gte: monthStart, $lte: monthEnd } },
          { delivered_at: null, status_updated_at: { $gte: monthStart, $lte: monthEnd } },
          { delivered_at: null, status_updated_at: null, createdAt: { $gte: monthStart, $lte: monthEnd } },
        ]
      }
    ]
  };

  const sr_orig = await Order.countDocuments(q_original);
  const sm_orig = await ShipmaxxOrder.countDocuments(q_original);
  
  const sr_new = await Order.countDocuments(q_new);
  const sm_new = await ShipmaxxOrder.countDocuments(q_new);

  // Let's also check all time deliveries for this user just in case
  const sr_all_verified = await Order.countDocuments({ verified_by: userId, status: { $in: ['DELIVERED', 'Delivered', 'delivered'] }});
  const sm_all_verified = await ShipmaxxOrder.countDocuments({ verified_by: userId, status: { $in: ['DELIVERED', 'Delivered', 'delivered'] }});
  
  // Find kits
  const srOrders_verified = await Order.find({ verified_by: userId, status: { $in: ['DELIVERED', 'Delivered', 'delivered'] }}).lean();
  const smOrders_verified = await ShipmaxxOrder.find({ verified_by: userId, status: { $in: ['DELIVERED', 'Delivered', 'delivered'] }}).lean();
  
  const allVerified = [...srOrders_verified, ...smOrders_verified];
  
  let kits = {};
  allVerified.forEach(o => {
      let kit = o.kit_number || 1;
      kits[kit] = (kits[kit] || 0) + 1;
  });

  console.log("Original query count:", sr_orig + sm_orig);
  console.log("New query count (verified_by, this month):", sr_new + sm_new);
  console.log("All time verified deliveries:", sr_all_verified + sm_all_verified);
  console.log("Kits breakdown all time:", kits);

  // Also check if any orders are 2-kit but verified by someone else?
  process.exit(0);
});

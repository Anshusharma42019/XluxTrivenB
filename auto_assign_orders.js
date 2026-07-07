import mongoose from 'mongoose';

const Order = mongoose.model('ShiprocketOrder', new mongoose.Schema({ status: String, lead_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' }, created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, billing_phone: String }, { strict: false }));
const ShipmaxxOrder = mongoose.model('ShipmaxxOrder', new mongoose.Schema({ status: String, lead_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' }, created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, billing_phone: String }, { strict: false }));
const Lead = mongoose.model('Lead', new mongoose.Schema({ phone: String, assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, isDeleted: Boolean }, { strict: false }));

const processOrders = async (Model, platformName) => {
  const unassigned = await Model.find({ lead_id: null }).lean();
  let assignedCount = 0;
  
  for (const order of unassigned) {
    if (!order.billing_phone) continue;
    const cleanPhone = String(order.billing_phone).replace(/\D/g, '');
    if (cleanPhone.length >= 10) {
      const leadMatch = await Lead.findOne({ phone: new RegExp(cleanPhone.slice(-10) + '$'), isDeleted: { $ne: true } }).select('_id').lean();
      if (leadMatch) {
        await Model.updateOne({ _id: order._id }, { $set: { lead_id: leadMatch._id } });
        assignedCount++;
        console.log(`Assigned ${platformName} order ${order._id} to lead ${leadMatch._id}`);
      }
    }
  }
  return assignedCount;
};

import dotenv from 'dotenv';
dotenv.config();

mongoose.connect(process.env.MONGODB_URL || 'mongodb://localhost:27017/xlux').then(async () => {
  const srCount = await processOrders(Order, 'Shiprocket');
  const smCount = await processOrders(ShipmaxxOrder, 'Shipmaxx');
  console.log(`Auto-assigned: ${srCount} Shiprocket, ${smCount} Shipmaxx`);
  process.exit(0);
}).catch(e => {
  console.error(e);
  process.exit(1);
});

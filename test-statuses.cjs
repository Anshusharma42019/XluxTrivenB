const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

mongoose.connect(process.env.MONGODB_URL).then(async () => {
  const Order = mongoose.model('ShipmaxxOrder', new mongoose.Schema({ status: String, platform: String }, { collection: 'orders' }));
  const stats = await Order.aggregate([
    { $match: { platform: 'shipmaxx' } },
    { $group: { _id: '$status', count: { $sum: 1 } } }
  ]);
  console.log('Statuses in DB:', stats);
  process.exit(0);
});

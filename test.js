const mongoose = require('mongoose');
mongoose.connect('mongodb+srv://developer:Triven123@cluster0.z2b60.mongodb.net/triven_crm?retryWrites=true&w=majority&appName=Cluster0')
.then(async () => {
  const db = mongoose.connection.db;
  const from = new Date('2026-06-21T00:00:00.000+05:30');
  const to = new Date('2026-06-27T23:59:59.999+05:30');
  
  const stats = await db.collection('shipmaxxorders').aggregate([
    { $match: { platform: 'shipmaxx', status_updated_at: { $gte: from, $lte: to } } },
    { $group: { _id: '$status', count: { $sum: 1 } } }
  ]).toArray();
  
  console.log(stats);
  process.exit(0);
});

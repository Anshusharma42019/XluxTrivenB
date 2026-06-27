const mongoose = require('mongoose');
mongoose.connect('mongodb+srv://AnshuSharma:Anshu92530@cluster0.r2qszni.mongodb.net/Triven-Data?appName=Cluster0')
.then(async () => {
  const db = mongoose.connection.db;
  const from = new Date('2026-06-21T00:00:00.000+05:30');
  const to = new Date('2026-06-27T23:59:59.999+05:30');
  
  const stats = await db.collection('shipmaxxorders').aggregate([
    { $match: { platform: 'shipmaxx', status_updated_at: { $gte: from, $lte: to } } },
    { $group: { _id: '$status', count: { $sum: 1 } } }
  ]).toArray();
  
  console.log('--- BY STATUS_UPDATED_AT ---');
  console.log(stats);

  const statsCreated = await db.collection('shipmaxxorders').aggregate([
    { $match: { platform: 'shipmaxx', createdAt: { $gte: from, $lte: to } } },
    { $group: { _id: '$status', count: { $sum: 1 } } }
  ]).toArray();

  console.log('--- BY CREATED_AT ---');
  console.log(statsCreated);

  process.exit(0);
});

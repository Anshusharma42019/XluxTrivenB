import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  const uri = process.env.MONGODB_URL || process.env.MONGO_URI;
  await mongoose.connect(uri);
  const db = mongoose.connection.db;

  const getStatusMatch = { 
    platform: 'shipmaxx', 
    status: { $in: [/^DELIVERED$/i, /^DEL$/i] },
    $or: [
      { delivered_at: { $gte: new Date('2026-07-02T18:30:00.000Z'), $lte: new Date('2026-07-03T18:29:59.999Z') } },
      { delivered_at: { $exists: false }, status_updated_at: { $gte: new Date('2026-07-02T18:30:00.000Z'), $lte: new Date('2026-07-03T18:29:59.999Z') } },
      { delivered_at: null, status_updated_at: { $gte: new Date('2026-07-02T18:30:00.000Z'), $lte: new Date('2026-07-03T18:29:59.999Z') } },
      { delivered_at: { $exists: false }, status_updated_at: { $exists: false }, createdAt: { $gte: new Date('2026-07-02T18:30:00.000Z'), $lte: new Date('2026-07-03T18:29:59.999Z') } },
      { delivered_at: null, status_updated_at: null, createdAt: { $gte: new Date('2026-07-02T18:30:00.000Z'), $lte: new Date('2026-07-03T18:29:59.999Z') } },
    ]
  };

  const getDeliveredStatsMatch = {
    status: /^delivered$/i,
    platform: 'shipmaxx',
    $or: [
      { status: { $in: [/^delivered$/i, /^rto_delivered$/i, /^DEL$/i, /^RTO$/i] }, delivered_at: { $gte: new Date('2026-07-02T18:30:00.000Z'), $lte: new Date('2026-07-03T18:29:59.999Z') } },
      { status: { $in: [/^delivered$/i, /^rto_delivered$/i, /^DEL$/i, /^RTO$/i] }, delivered_at: { $exists: false }, status_updated_at: { $gte: new Date('2026-07-02T18:30:00.000Z'), $lte: new Date('2026-07-03T18:29:59.999Z') } },
      { status: { $in: [/^delivered$/i, /^rto_delivered$/i, /^DEL$/i, /^RTO$/i] }, delivered_at: null, status_updated_at: { $gte: new Date('2026-07-02T18:30:00.000Z'), $lte: new Date('2026-07-03T18:29:59.999Z') } },
      { status: { $not: /^(delivered|rto_delivered|DEL|RTO)$/i }, status_updated_at: { $gte: new Date('2026-07-02T18:30:00.000Z'), $lte: new Date('2026-07-03T18:29:59.999Z') } },
      { status_updated_at: { $exists: false }, createdAt: { $gte: new Date('2026-07-02T18:30:00.000Z'), $lte: new Date('2026-07-03T18:29:59.999Z') } },
      { status_updated_at: null, createdAt: { $gte: new Date('2026-07-02T18:30:00.000Z'), $lte: new Date('2026-07-03T18:29:59.999Z') } },
    ]
  };

  const getStatusRes = await db.collection('shipmaxxorders').find(getStatusMatch).toArray();
  const getStatsRes = await db.collection('shipmaxxorders').find(getDeliveredStatsMatch).toArray();

  console.log('getStatusOrders count:', getStatusRes.length);
  console.log('getDeliveredStats count:', getStatsRes.length);
  
  if (getStatsRes.length > getStatusRes.length) {
    const missing = getStatsRes.filter(a => !getStatusRes.find(b => a._id.toString() === b._id.toString()));
    console.log('Missing in getStatusOrders:', missing.map(m => ({ 
      id: m._id, 
      status: m.status, 
      delivered_at: m.delivered_at, 
      status_updated_at: m.status_updated_at, 
      createdAt: m.createdAt 
    })));
  }

  process.exit(0);
}
run();

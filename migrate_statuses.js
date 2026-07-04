import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  const uri = process.env.MONGODB_URL || process.env.MONGO_URI;
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  
  const updates = [
    { old: 'CANCELED', new: 'SHIPMENT_CANCELLED' },
    { old: 'RTO_IN_TRANSIT', new: 'RTO_INTRANSIT' }
  ];
  
  for (const u of updates) {
    const r = await db.collection('shipmaxxorders').updateMany({ platform: 'shipmaxx', status: u.old }, { $set: { status: u.new } });
    console.log('shipmaxxorders', u.old, '->', u.new, r.modifiedCount);
    const r2 = await db.collection('intransitorders').updateMany({ status: u.old }, { $set: { status: u.new } });
    console.log('intransitorders', u.old, '->', u.new, r2.modifiedCount);
  }
  
  // Actually SPB is Shipment Booked so NEW -> SHIPMENT_BOOKED
  const r3 = await db.collection('shipmaxxorders').updateMany({ platform: 'shipmaxx', status: 'NEW', awb_code: { $exists: true, $ne: '' } }, { $set: { status: 'SHIPMENT_BOOKED' } });
  console.log('shipmaxxorders NEW -> SHIPMENT_BOOKED (with AWB)', r3.modifiedCount);
  
  const r4 = await db.collection('intransitorders').updateMany({ status: 'NEW', awb_code: { $exists: true, $ne: '' } }, { $set: { status: 'SHIPMENT_BOOKED' } });
  console.log('intransitorders NEW -> SHIPMENT_BOOKED (with AWB)', r4.modifiedCount);

  // PICKUP_EXCEPTION is not in user list, DEX is Delivery Exception.
  const r5 = await db.collection('shipmaxxorders').updateMany({ platform: 'shipmaxx', status: 'PICKUP_EXCEPTION' }, { $set: { status: 'DELIVERY_EXCEPTION' } });
  console.log('shipmaxxorders PICKUP_EXCEPTION -> DELIVERY_EXCEPTION', r5.modifiedCount);

  const r6 = await db.collection('intransitorders').updateMany({ status: 'PICKUP_EXCEPTION' }, { $set: { status: 'DELIVERY_EXCEPTION' } });
  console.log('intransitorders PICKUP_EXCEPTION -> DELIVERY_EXCEPTION', r6.modifiedCount);

  process.exit(0);
}
run();

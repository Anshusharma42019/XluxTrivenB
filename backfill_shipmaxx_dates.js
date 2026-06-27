import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config({ path: '.env' });
import smx from './src/modules/shipmaxx/shipmaxx.service.js';

async function backfillDelivered() {
  await mongoose.connect(process.env.MONGODB_URL);
  const db = mongoose.connection.db;
  
  const orders = await db.collection('shipmaxxorders').find({ platform: 'shipmaxx', status: 'DELIVERED' }).toArray();
  console.log(`Found ${orders.length} DELIVERED orders. Starting backfill...`);
  
  let updatedCount = 0;
  
  // Process in batches of 5
  for (let i = 0; i < orders.length; i += 5) {
    const batch = orders.slice(i, i + 5);
    await Promise.all(batch.map(async (o) => {
      try {
        if (!o.awb_code) return;
        const trackRes = await smx.trackShipment(o.awb_code);
        const trackingList = trackRes?.data?.data || [];
        
        let deliveredDate = null;
        for (const t of trackingList) {
          if (/delivered/i.test(t.tracking_status)) {
            deliveredDate = new Date(t.date_added);
            break; // found the first (or last) delivered status
          }
        }
        
        // If we didn't find "delivered", fallback to the most recent tracking event
        if (!deliveredDate && trackingList.length > 0) {
           deliveredDate = new Date(trackingList[trackingList.length - 1].date_added);
        }
        
        if (deliveredDate) {
          await db.collection('shipmaxxorders').updateOne(
            { _id: o._id },
            { $set: { status_updated_at: deliveredDate, delivered_at: deliveredDate } }
          );
          updatedCount++;
        }
      } catch (err) {
        // ignore tracking errors for now
      }
    }));
    if (i % 50 === 0) console.log(`Processed ${i} / ${orders.length}`);
  }
  
  console.log(`Backfill complete. Updated ${updatedCount} orders.`);
  
  const juneCount = await db.collection('shipmaxxorders').countDocuments({
    platform: 'shipmaxx',
    status: 'DELIVERED',
    status_updated_at: { $gte: new Date('2026-06-01T00:00:00.000+05:30'), $lte: new Date('2026-06-30T23:59:59.999+05:30') }
  });
  
  console.log(`\n✅ FINAL COUNT FOR JUNE (1st to 30th): ${juneCount} DELIVERED ORDERS`);
  process.exit();
}

backfillDelivered().catch(console.error);

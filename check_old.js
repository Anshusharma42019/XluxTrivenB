import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });
const url = process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017/xluxtech';

async function run() {
  const client = new MongoClient(url);
  try {
    await client.connect();
    const db = client.db();

    const month = new Date().getMonth();
    const year = new Date().getFullYear();
    const IST_OFFSET = 5.5 * 60 * 60 * 1000;
    const monthStart = new Date(Date.UTC(year, month, 1) - IST_OFFSET);
    const monthEnd = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999) - IST_OFFSET);

    const filter = {
      source_order_id: null,
      status: { $in: ['DELIVERED', 'Delivered', 'delivered'] },
      $or: [
        { delivered_at: { $gte: monthStart, $lte: monthEnd } },
        { delivered_at: null, status_updated_at: { $gte: monthStart, $lte: monthEnd } },
        { delivered_at: null, status_updated_at: null, createdAt: { $gte: monthStart, $lte: monthEnd } },
      ]
    };

    const smOrders = await db.collection('shipmaxxorders').find(filter).toArray();
    
    // Check how many were created BEFORE July 1st
    const oldOrders = smOrders.filter(o => new Date(o.createdAt) < monthStart);
    
    console.log(`Total Shipmaxx Delivered: ${smOrders.length}`);
    console.log(`Of those, created BEFORE this month: ${oldOrders.length}`);
    
    if (oldOrders.length > 0) {
      console.log('Old orders:');
      for (const o of oldOrders) {
        console.log(`ID: ${o.order_id}, CreatedAt: ${o.createdAt}, DeliveredAt: ${o.delivered_at}, StatusUpdatedAt: ${o.status_updated_at}`);
      }
    }

  } catch (err) {
    console.error(err);
  } finally {
    await client.close();
  }
}
run();

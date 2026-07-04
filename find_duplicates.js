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

    const srOrders = await db.collection('shiprocketorders').find(filter).toArray();
    const smOrders = await db.collection('shipmaxxorders').find(filter).toArray();

    console.log(`SR Orders: ${srOrders.length}`);
    console.log(`SM Orders: ${smOrders.length}`);

    const srLeadIds = srOrders.map(o => String(o.lead_id)).filter(id => id && id !== 'null' && id !== 'undefined');
    const smLeadIds = smOrders.map(o => String(o.lead_id)).filter(id => id && id !== 'null' && id !== 'undefined');

    const duplicates = srLeadIds.filter(id => smLeadIds.includes(id));
    console.log(`Duplicates (Lead IDs in both SR and SM): ${duplicates.length}`);
    if (duplicates.length > 0) {
      console.log('Duplicate Lead IDs:', duplicates);
    }
  } catch (err) {
    console.error(err);
  } finally {
    await client.close();
  }
}
run();

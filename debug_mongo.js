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

    console.log('Month Start:', monthStart);
    console.log('Month End:', monthEnd);

    // Get all users
    const users = await db.collection('users').find({ role: { $in: ['sales', 'manager', 'staff', 'admin'] } }).toArray();

    let srTotal = 0;
    let smTotal = 0;

    for (const user of users) {
      const leads = await db.collection('leads').find({ assignedTo: user._id, isDeleted: { $ne: true } }).project({ _id: 1 }).toArray();
      const staffLeads = leads.map(l => l._id);

      if (staffLeads.length === 0) continue;

      const srOrders = await db.collection('shiprocketorders').find({
        lead_id: { $in: staffLeads },
        source_order_id: null,
        status: { $in: ['DELIVERED', 'Delivered', 'delivered'] },
        $or: [
          { delivered_at: { $gte: monthStart, $lte: monthEnd } },
          { delivered_at: null, status_updated_at: { $gte: monthStart, $lte: monthEnd } },
          { delivered_at: null, status_updated_at: null, createdAt: { $gte: monthStart, $lte: monthEnd } },
        ]
      }).toArray();

      const smOrders = await db.collection('shipmaxxorders').find({
        source_order_id: null,
        $or: [ { lead_id: { $in: staffLeads } }, { lead_id: null, created_by: user._id } ],
        status: { $in: ['DELIVERED', 'Delivered', 'delivered'] },
        $and: [
          {
            $or: [
              { delivered_at: { $gte: monthStart, $lte: monthEnd } },
              { delivered_at: null, status_updated_at: { $gte: monthStart, $lte: monthEnd } },
              { delivered_at: null, status_updated_at: null, createdAt: { $gte: monthStart, $lte: monthEnd } },
            ]
          }
        ]
      }).toArray();

      srTotal += srOrders.length;
      smTotal += smOrders.length;
      
      const total = srOrders.length + smOrders.length;
      if (total > 0) {
         console.log(`User ${user.name} has ${total} deliveries (SR: ${srOrders.length}, SM: ${smOrders.length})`);
         if (total > 20) {
            console.log('  SR Orders:');
            srOrders.forEach(o => console.log(`    ${o._id} - ${o.awb_code} - ${o.lead_id}`));
            console.log('  SM Orders:');
            smOrders.forEach(o => console.log(`    ${o._id} - ${o.awb_code} - ${o.lead_id}`));
         }
      }
    }
    console.log(`Total SR: ${srTotal}, SM: ${smTotal}, SUM: ${srTotal + smTotal}`);

  } catch (err) {
    console.error(err);
  } finally {
    await client.close();
  }
}

run();

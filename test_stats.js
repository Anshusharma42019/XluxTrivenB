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
    const start = new Date(Date.UTC(year, month, 1) - IST_OFFSET);
    const end = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999) - IST_OFFSET);

    const deliveredFilter = {
      status: { $in: ['DELIVERED', 'Delivered', 'delivered'] },
      $or: [
        { delivered_at: { $gte: start, $lte: end } },
        { delivered_at: null, status_updated_at: { $gte: start, $lte: end } },
        { delivered_at: null, status_updated_at: null, createdAt: { $gte: start, $lte: end } },
      ]
    };
    
    // We are simulating what getDashboardStats does for Admin (no role filter)
    const srDelivered = await db.collection('shiprocketorders').countDocuments(deliveredFilter);
    const smDelivered = await db.collection('shipmaxxorders').countDocuments(deliveredFilter);
    
    console.log(`SR Delivered: ${srDelivered}`);
    console.log(`SM Delivered: ${smDelivered}`);
    console.log(`Total Delivered in getDashboardStats: ${srDelivered + smDelivered}`);

    // Wait, what if userRole === 'manager' and userDepartments && userDepartments.length > 0?
    // In dashboard.service.js getDashboardStats:
    // if (userRole === 'sales' || (userDepartments && userDepartments.length > 0)) {
    //   deliveredFilter.lead_id = { $in: staffLeads };
    // }
    // If Prashant is a manager with departments = ['migraine']? 
    // Wait, Prashant's departments array might not be empty!

    const prashant = await db.collection('users').findOne({ name: /Prashant/i });
    if (prashant) {
      console.log('Prashant departments:', prashant.departments);
      const leads = await db.collection('leads').find({ assignedTo: prashant._id, isDeleted: { $ne: true } }).project({ _id: 1 }).toArray();
      const staffLeads = leads.map(l => l._id);
      
      const prashantFilter = { ...deliveredFilter, lead_id: { $in: staffLeads } };
      
      const prashantSR = await db.collection('shiprocketorders').countDocuments(prashantFilter);
      const prashantSM = await db.collection('shipmaxxorders').countDocuments(prashantFilter);
      console.log(`Prashant filtered SR: ${prashantSR}`);
      console.log(`Prashant filtered SM: ${prashantSM}`);
      console.log(`Prashant Total filtered: ${prashantSR + prashantSM}`);
    }

  } catch (err) {
    console.error(err);
  } finally {
    await client.close();
  }
}
run();

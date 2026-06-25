import 'dotenv/config';
import mongoose from 'mongoose';
import axios from 'axios';

const BASE_URL = process.env.SHIPMAXX_BASE_URL || 'https://appapi.losung360.com/external/v1';

const parseShipMaxxDate = (dateStr) => {
  if (!dateStr) return new Date();
  const parts = String(dateStr).trim().match(/^(\d{2})-(\d{2})-(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (parts) {
    const [_, d, m, y, h, min, s] = parts;
    return new Date(`${y}-${m}-${d}T${h || '00'}:${min || '00'}:${s || '00'}+05:30`);
  }
  return new Date(dateStr);
};

export const fixDates = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URL);
    const db = mongoose.connection.db;
    
    console.log('Logging into ShipMaxx...');
    const loginRes = await axios.post(process.env.SHIPMAXX_AUTH_URL + '/auth/login', {
      email_id: process.env.SHIPMAXX_EMAIL,
      password: process.env.SHIPMAXX_PASSWORD
    });
    const token = loginRes.data.access_token;

    // Fetch all shipmaxx orders with an AWB that have a date to fix
    // We can just fetch ALL orders that have an AWB code and a status_updated_at or delivered_at
    // But since the user specifically noticed this on DELIVERED, let's fix all
    const orders = await db.collection('shipmaxxorders').find({ 
      platform: 'shipmaxx', 
      awb_code: { $exists: true, $ne: '' } 
    }).toArray();
    
    console.log(`Found ${orders.length} orders to check.`);

    let fixedCount = 0;
    const errors = [];
    for (let i=0; i<orders.length; i++) {
      const o = orders[i];
      
      try {
        const trackRes = await axios.get(`${BASE_URL}/shipping/track-shipment?awb=${o.awb_code}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        const tracking = trackRes.data.data || trackRes.data || {};
        
        let update = {};
        if (tracking.history && Array.isArray(tracking.history)) {
          const latestEvent = tracking.history[0];
          if (latestEvent && latestEvent.timestamp) update.status_updated_at = parseShipMaxxDate(latestEvent.timestamp);
          
          const delEvent = tracking.history.find(h => h.system_status_code === 'DEL' || (h.system_status_name || '').toLowerCase() === 'delivered');
          if (delEvent && delEvent.timestamp) {
            update.delivered_at = parseShipMaxxDate(delEvent.timestamp);
            if (!update.status_updated_at) update.status_updated_at = update.delivered_at;
          }
        }
        
        if (Object.keys(update).length > 0) {
          await db.collection('shipmaxxorders').updateOne({ _id: o._id }, { $set: update });
          fixedCount++;
          if (fixedCount % 10 === 0) console.log(`Fixed ${fixedCount}...`);
        }
      } catch (err) {
        const msg = err.response?.data?.message || err.response?.data?.detail || err.message;
        errors.push(`AWB ${o.awb_code}: ${msg}`);
      }
      
      await new Promise(r => setTimeout(r, 100)); // Rate limiting
    }

    console.log(`Finished fixing ${fixedCount} orders dates!`);
    process.exit(0);
  } catch(e) {
    console.error('Error fixing dates:', e);
    process.exit(1);
  }
};
fixDates();

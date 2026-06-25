import 'dotenv/config';
import connectDB from './src/config/database.js';
import { Order } from './src/modules/shiprocket/models/order.model.js';
import * as smx from './src/modules/shipmaxx/shipmaxx.service.js';

const SMX_MAP = {
  DEL: 'DELIVERED',
  INT: 'IN_TRANSIT',
  UND: 'UNDELIVERED',
  RTO: 'RTO_DELIVERED',
  OFD: 'OUT_FOR_DELIVERY',
  DEX: 'UNDELIVERED_ATTEMPT_FAILURE',
  SC:  'SHIPPED',
  PCN: 'CANCELED',
  RRA: 'REACHED_AT_DESTINATION_HUB',
  SPD: 'PICKUP_SCHEDULED',
  SPB: 'NEW'
};

async function backfill() {
  try {
    await connectDB();
    await smx.login();
    console.log('Connected. Starting full backfill...');

    let page = 1;
    let inserted = 0;

    while (true) {
      console.log(`Fetching page ${page}...`);
      const res = await smx.getShipments({ limit: 50, per_page: 50, page });
      let arr = res?.data?.data || res?.data || [];
      if (!Array.isArray(arr) && res?.shipments) arr = res.shipments;
      
      if (arr.length === 0) break;

      for (const s of arr) {
        if (!s.awb && !s.order_id) continue;
        const query = { platform: 'shipmaxx' };
        if (s.order_id) query.order_id = String(s.order_id);
        else query.awb_code = String(s.awb);

        let rawStatus = s.status ? String(s.status).toUpperCase().trim() : 'NEW';
        let status = SMX_MAP[rawStatus] || rawStatus.replace(/[\s-]+/g, '_');

        const updateData = {
          order_id: String(s.order_id || s.awb),
          awb_code: String(s.awb || ''),
          status: status,
          platform: 'shipmaxx',
          payment_method: s.payment_method || '',
          status_updated_at: s.created_at ? new Date(s.created_at) : new Date(),
        };

        if (s.customer_name) updateData.billing_customer_name = s.customer_name;
        if (s.customer_phone) updateData.billing_phone = s.customer_phone;

        await Order.findOneAndUpdate(query, { $set: updateData }, { upsert: true }).catch(() => {});
        inserted++;
      }
      
      if (arr.length < 15) break;
      page++;
      if (page > 50) break; // safety
    }
    console.log(`Successfully backfilled ${inserted} historical ShipMaxx shipments!`);
    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

backfill();

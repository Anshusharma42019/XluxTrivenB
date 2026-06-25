import 'dotenv/config';
import * as smx from './src/modules/shipmaxx/shipmaxx.service.js';

async function testStatuses() {
  try {
    await smx.login();
    const result = await smx.getShipments({ limit: 1000, page: 1 });
    let arr = result?.data?.data || result?.data || [];
    if (!Array.isArray(arr) && result?.shipments) arr = result.shipments;

    const statuses = {};
    arr.forEach(s => {
      const st = s.status || 'undefined';
      statuses[st] = (statuses[st] || 0) + 1;
    });

    console.log('Unique statuses in getShipments:', statuses);
    console.log('Sample shipment:', arr.find(s => s.status === 'DEL' || s.status === 'INT') || arr[0]);

  } catch (err) {
    console.error('Error fetching shipments:', err.message);
  }
}

testStatuses();

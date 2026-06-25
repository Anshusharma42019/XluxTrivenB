import 'dotenv/config';
import * as smx from './src/modules/shipmaxx/shipmaxx.service.js';

async function testFetchOrder() {
  try {
    await smx.login();
    // Fetch a single shipment
    const shipRes = await smx.getShipments({ limit: 1 });
    let arr = shipRes?.data?.data || shipRes?.data || [];
    if (!Array.isArray(arr) && shipRes?.shipments) arr = shipRes.shipments;
    const shipment = arr[0];
    
    console.log('--- SHIPMENT DATA ---');
    console.log(JSON.stringify(shipment, null, 2));

    // Try fetching the full order details for this shipment
    if (shipment && shipment.order_id) {
      try {
        const orderRes = await smx.getOrder(shipment.order_id);
        console.log('\n--- ORDER DATA ---');
        console.log(JSON.stringify(orderRes, null, 2));
      } catch (e) {
        console.log('\nCould not fetch full order details:', e.message);
      }
    }
  } catch (err) {
    console.error('Error:', err.message);
  }
}
testFetchOrder();

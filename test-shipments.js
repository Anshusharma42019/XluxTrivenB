import 'dotenv/config';
import * as smx from './src/modules/shipmaxx/shipmaxx.service.js';

async function testShipments() {
  try {
    await smx.login();
    const result = await smx.getShipments({ limit: 10, page: 1 });
    console.log('Result keys:', Object.keys(result));
    
    // Find the array
    let arr = [];
    if (result.shipments) arr = result.shipments;
    else if (result.data) arr = result.data;
    else if (Array.isArray(result)) arr = result;
    
    console.log(`Extracted array length: ${arr.length}`);
    if (arr.length > 0) {
      console.log('First shipment keys:', Object.keys(arr[0]));
      console.log('First shipment status:', arr[0].status || arr[0].tracking_status);
    }
  } catch (err) {
    console.error('Error fetching shipments:', err.message);
  }
}

testShipments();

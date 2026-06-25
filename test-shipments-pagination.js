import 'dotenv/config';
import * as smx from './src/modules/shipmaxx/shipmaxx.service.js';

async function testPagination() {
  try {
    await smx.login();
    let page = 1;
    let totalFetched = 0;
    while (true) {
      const res = await smx.getShipments({ limit: 50, per_page: 50, page });
      let arr = res?.data?.data || res?.data || [];
      if (!Array.isArray(arr) && res?.shipments) arr = res.shipments;
      
      console.log(`Page ${page}: fetched ${arr.length} shipments.`);
      totalFetched += arr.length;
      
      if (arr.length === 0 || arr.length < 15) { // default page size is usually 15 or 50
        break;
      }
      page++;
      
      // Safety limit
      if (page > 20) break;
    }
    console.log(`Total shipments fetched: ${totalFetched}`);
  } catch (err) {
    console.error('Error fetching shipments:', err.message);
  }
}

testPagination();

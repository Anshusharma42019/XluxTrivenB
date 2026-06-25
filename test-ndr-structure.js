import 'dotenv/config';
import * as smx from './src/modules/shipmaxx/shipmaxx.service.js';

async function testNdrPages() {
  try {
    await smx.login();
    
    // Page 1
    const p1 = await smx.getNdrList({ limit: 1000, per_page: 1000, page: 1 });
    console.log(`Page 1 Length: ${p1.shipments ? p1.shipments.length : 0}`);
    
    // Page 2
    const p2 = await smx.getNdrList({ limit: 1000, per_page: 1000, page: 2 });
    console.log(`Page 2 Length: ${p2.shipments ? p2.shipments.length : 0}`);
    
    // Try with dates (e.g. last 6 months)
    const p3 = await smx.getNdrList({ 
      limit: 1000, 
      per_page: 1000,
      from_date: '2023-01-01',
      to_date: '2026-12-31'
    });
    console.log(`With Dates Length: ${p3.shipments ? p3.shipments.length : 0}`);
    
  } catch (err) {
    console.error('Error:', err.message);
  }
}

testNdrPages();

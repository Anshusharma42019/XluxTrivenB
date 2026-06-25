import 'dotenv/config';
import * as smx from './src/modules/shipmaxx/shipmaxx.service.js';

async function testNdrStrings() {
  try {
    await smx.login();
    const result = await smx.getNdrList({ limit: '1000', per_page: '1000' });
    console.log(`Length with strings: ${result.shipments ? result.shipments.length : 0}`);
  } catch (err) {
    console.error('Error:', err.message);
  }
}

testNdrStrings();

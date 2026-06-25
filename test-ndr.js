import 'dotenv/config';
import * as smx from './src/modules/shipmaxx/shipmaxx.service.js';

async function testNdr() {
  try {
    console.log('Logging into ShipMaxx...');
    await smx.login();
    
    console.log('\nFetching NDR list from ShipMaxx...');
    const result = await smx.getNdrList();
    
    console.log('\n--- ShipMaxx /ndr Response ---');
    console.log(JSON.stringify(result, null, 2));
    console.log('------------------------------');
    
  } catch (err) {
    console.error('Error fetching NDR:', err.message);
    if (err.response) {
      console.error('Response data:', err.response.data);
    }
  }
}

testNdr();

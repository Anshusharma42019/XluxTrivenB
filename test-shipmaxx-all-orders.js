import 'dotenv/config';
import * as smx from './src/modules/shipmaxx/shipmaxx.service.js';

async function testFetchAllOrders() {
  try {
    await smx.login();
    const ordersRes = await smx.fetchAllOrders({ limit: 2, per_page: 2 });
    let arr = ordersRes?.data?.data || ordersRes?.data || ordersRes?.orders || [];
    if (!Array.isArray(arr) && ordersRes?.orders) arr = ordersRes.orders;
    
    console.log('--- ALL ORDERS API ---');
    console.log(JSON.stringify(arr[0], null, 2));
  } catch (err) {
    console.error('Error:', err.message);
  }
}
testFetchAllOrders();

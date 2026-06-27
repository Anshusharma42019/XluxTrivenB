import dotenv from 'dotenv'; dotenv.config({ path: '.env' });
import smx from './src/modules/shipmaxx/shipmaxx.service.js';

smx.fetchAllOrders({ limit: 1, per_page: 1, page: 1 })
  .then(res => {
    const arr = res?.data?.data || res?.data || res?.orders || [];
    console.log(JSON.stringify(arr[0], null, 2));
    process.exit(0);
  })
  .catch(e => {
    console.error(e.response?.data || e.message);
    process.exit(1);
  });

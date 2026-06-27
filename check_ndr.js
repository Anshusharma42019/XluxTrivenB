import dotenv from 'dotenv'; dotenv.config({ path: '.env' });
import smx from './src/modules/shipmaxx/shipmaxx.service.js';

smx.getNdrList({})
  .then(res => {
    console.log(JSON.stringify(res, null, 2));
    process.exit(0);
  })
  .catch(e => {
    console.error(e.response?.data || e.message);
    process.exit(1);
  });

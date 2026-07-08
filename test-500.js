import mongoose from 'mongoose';
import 'dotenv/config';
import { getLeads } from './src/modules/lead/lead.service.js';

async function run() {
  await mongoose.connect(process.env.MONGODB_URL);
  
  try {
    const filter = { dateFrom: '2026-07-08', dateTo: '2026-07-08', status: 'new' };
    const options = { page: 1, limit: 15 };
    const result = await getLeads(filter, options, 'sales', '666666666666666666666666');
    console.log('Success!', result.leads.length);
  } catch (err) {
    console.error('ERROR CAUGHT:', err.stack);
  }

  process.exit(0);
}

run();

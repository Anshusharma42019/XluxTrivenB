import connectDB from './src/config/database.js';
import { getNextSalesUser, distributeAbsentSalesLeads } from './src/modules/lead/lead.service.js';
import mongoose from 'mongoose';
import dns from 'dns';

dns.setServers(['8.8.8.8', '8.8.4.4']);

async function runTest() {
  await connectDB();
  console.log("--- Testing Night Lead Assignment (getNextSalesUser) ---");
  try {
    const nextUser = await getNextSalesUser();
    console.log("Assigned User ID:", nextUser);
  } catch(e) {
    console.error("Error in getNextSalesUser:", e);
  }

  console.log("\n--- Testing Absent Sales Redistribution (distributeAbsentSalesLeads) ---");
  try {
    const result = await distributeAbsentSalesLeads();
    console.log("Redistribution Result:", result);
  } catch(e) {
    console.error("Error in distributeAbsentSalesLeads:", e);
  }
  
  process.exit(0);
}

runTest();

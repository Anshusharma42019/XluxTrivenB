import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { getAllStaffCommissions } from '../src/modules/dashboard/dashboard.service.js';

dotenv.config();

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URL);
  console.log('Connected to MongoDB');
  
  // May 2026 (month = 4, 0-indexed)
  const result = await getAllStaffCommissions(4, 2026);
  console.log('--- MAY 2026 STAFF ---');
  result.staff.forEach(s => {
    console.log(`${s.user.name}: Joined ${s.user.joiningDate || s.user.createdAt}`);
  });
  
  await mongoose.disconnect();
};

run().catch(console.error);

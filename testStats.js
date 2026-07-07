import 'dotenv/config';
import mongoose from 'mongoose';
import { getDashboardStats } from './src/modules/dashboard/dashboard.service.js';

await mongoose.connect(process.env.MONGODB_URL);

const dateStr = '2026-07-07';
// Passing from='all' and to='all' to see all time, but the user wants 'this month' probably?
// Let's pass '2026-07-01' to '2026-07-31'
const stats = await getDashboardStats('admin', null, dateStr, '2026-07-01', '2026-07-31');

console.log('Delivered Count:', stats.deliveredCount);
console.log('New Delivered:', stats.newDeliveredCount);
console.log('Old Delivered:', stats.oldDeliveredCount);

process.exit(0);

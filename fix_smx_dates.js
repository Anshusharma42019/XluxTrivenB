import 'dotenv/config';
import mongoose from 'mongoose';
import { fixDates } from './fix-delivered-dates.js';

async function run() {
  try {
    console.log('Connecting to DB...');
    await mongoose.connect(process.env.MONGODB_URL);
    console.log('Connected. Starting date fix...');
    await fixDates();
    console.log('Done!');
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
run();

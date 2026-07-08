import mongoose from 'mongoose';
import 'dotenv/config';

async function run() {
  try {
    new mongoose.Types.ObjectId("null");
  } catch (err) {
    console.error('ERROR CAUGHT:', err.message);
  }
  process.exit(0);
}

run();

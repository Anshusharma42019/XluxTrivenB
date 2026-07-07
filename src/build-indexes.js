import connectDB from './config/database.js';
import mongoose from 'mongoose';

// Import all models to register their schemas in Mongoose
import User from './modules/user/user.model.js';
import Lead from './modules/lead/lead.model.js';
import Task from './modules/task/task.model.js';
import Verification from './modules/verification/verification.model.js';
import Cnp from './modules/cnp/cnp.model.js';
import CallAgain from './modules/callagain/callagain.model.js';
import { Order } from './modules/shiprocket/models/order.model.js';
import { ShipmaxxOrder } from './modules/shipmaxx/models/shipmaxxOrder.model.js';
import ReadyToShipment from './modules/readytoshipment/readytoshipment.model.js';

async function run() {
  await connectDB();
  console.log('Building indexes...');
  const models = [
    User, Lead, Task, Verification, Cnp, CallAgain, Order, ShipmaxxOrder, ReadyToShipment
  ];
  for (const model of models) {
    console.log(`Syncing indexes for ${model.modelName}...`);
    try {
      const res = await model.syncIndexes();
      console.log(`[Success] Synced indexes for ${model.modelName}:`, res);
    } catch (e) {
      console.error(`[Error] Failed to sync indexes for ${model.modelName}:`, e.message);
    }
  }
  console.log('Indexes building complete!');
  process.exit(0);
}

run();

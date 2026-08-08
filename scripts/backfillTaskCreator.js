import mongoose from 'mongoose';
import { config } from '../src/config/config.js'; 

const backfill = async () => {
  try {
    await mongoose.connect(config.mongoose.url, config.mongoose.options);
    console.log('Connected to MongoDB');

    const Order = (await import('../src/modules/shiprocket/models/order.model.js')).Order;
    const ShipmaxxOrder = (await import('../src/modules/shipmaxx/models/shipmaxxOrder.model.js')).ShipmaxxOrder;
    const Verification = (await import('../src/modules/verification/verification.model.js')).default;
    const Task = (await import('../src/modules/task/task.model.js')).default;

    const models = [Order, ShipmaxxOrder];
    
    for (const Model of models) {
      if (!Model) {
          console.log('Model not found');
          continue;
      }
      console.log(`Processing model ${Model.modelName}...`);
      const orders = await Model.find({ verification_id: { $ne: null }, task_created_by: null }).select('_id verification_id').lean();
      console.log(`Found ${orders.length} orders to check.`);

      let updatedCount = 0;
      for (const order of orders) {
        const verif = await Verification.findById(order.verification_id).select('task').lean();
        if (verif && verif.task) {
          const task = await Task.findById(verif.task).select('createdBy').lean();
          if (task && task.createdBy) {
            await Model.updateOne({ _id: order._id }, { $set: { task_created_by: task.createdBy } });
            updatedCount++;
          }
        }
      }
      console.log(`Updated ${updatedCount} ${Model.modelName}s.`);
    }

    console.log('Done.');
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
};

backfill();

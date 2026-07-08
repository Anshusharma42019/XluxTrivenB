import mongoose from 'mongoose';

async function run() {
  await mongoose.connect('mongodb://localhost:27017/xlux');
  try {
    const Verification = (await import('./src/modules/verification/verification.model.js')).default;
    const Task = (await import('./src/modules/task/task.model.js')).default;
    const ReadyToShipment = (await import('./src/modules/readytoshipment/readytoshipment.model.js')).default;
    const Lead = (await import('./src/modules/lead/lead.model.js')).default;

    const onHoldRecords = await Verification.find({ status: 'on_hold' }).lean();
    for (const record of onHoldRecords) {
      if (record.lead) await Lead.findByIdAndUpdate(record.lead, {
        status: 'on_hold',
        cnp: false,
        ...(record.onHoldReason && { onHoldReason: record.onHoldReason }),
        ...(record.onHoldUntil && { onHoldUntil: record.onHoldUntil }),
      });
      if (record.task) await Task.findByIdAndUpdate(record.task, { status: 'on_hold' });
    }

    const verifiedRecords = await Verification.find({ status: 'verified' })
      .populate('assignedTo', 'name email')
      .populate('lead', 'name phone status createdBy assignedTo pending_reorder_source');

    let fixed = 0;
    for (const record of verifiedRecords) {
      if (!record.task) continue;
      let rtsAssignedTo = record.assignedTo?._id || record.assignedTo;
      await Task.findByIdAndUpdate(record.task, { status: 'ready_to_shipment', assignedTo: rtsAssignedTo });
      await ReadyToShipment.findOneAndUpdate(
        { task: record.task },
        {
          $set: {
            title: record.title,
            assignedTo: rtsAssignedTo,
            lead: record.lead?._id || record.lead,
            description: record.description,
            problem: record.problem,
            age: record.age, weight: record.weight, height: record.height,
            otherProblems: record.otherProblems, problemDuration: record.problemDuration,
            price: record.price,
            cityVillageType: record.cityVillageType, cityVillage: record.cityVillage,
            houseNo: record.houseNo, postOffice: record.postOffice,
            district: record.district, landmark: record.landmark,
            pincode: record.pincode, state: record.state,
            reminderAt: record.reminderAt,
          },
          $setOnInsert: { task: record.task },
        },
        { upsert: true }
      );
      fixed++;
    }
    console.log('Fixed', fixed);
    process.exit(0);
  } catch (e) {
    console.error('ERROR:', e);
    process.exit(1);
  }
}

run();

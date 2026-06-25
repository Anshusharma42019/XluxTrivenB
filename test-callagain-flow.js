const mongoose = require('mongoose');
const Task = require('./src/modules/task/task.model.js').default;
const Lead = require('./src/modules/lead/lead.model.js').default;
const CallAgain = require('./src/modules/callagain/callagain.model.js').default;
const { createTask, getDailyTasks, getTasks } = require('./src/modules/task/task.service.js');

mongoose.connect('mongodb+srv://AnshuSharma:Anshu92530@cluster0.r2qszni.mongodb.net/Triven-Data?appName=Cluster0').then(async () => {
  try {
    // find a callagain record
    const callAgain = await CallAgain.findOne({ status: { $ne: 'done' } });
    if (!callAgain) {
      console.log('No CallAgain record found');
      process.exit(0);
    }
    console.log('CallAgain Lead ID:', callAgain.lead);

    const lead = await Lead.findById(callAgain.lead);
    console.log('Original Lead Status:', lead.status);

    // simulate frontend updateLead
    lead.status = 'pending';
    lead.cnp = false;
    await lead.save();

    // simulate createTask
    const taskPayload = {
      title: 'TEST CALL AGAIN TASK',
      lead: lead._id,
      assignedTo: lead.assignedTo,
      type: 'task',
      status: 'pending',
      dueDate: new Date(new Date().setHours(23,59,59,999))
    };
    const newTask = await createTask(taskPayload, lead.createdBy, 'admin');
    console.log('Created Task ID:', newTask._id, 'DueDate:', newTask.dueDate);

    // check if getTasks returns it
    const tasks = await getTasks({ status: 'pending' }, 'admin', lead.createdBy);
    const foundTask = tasks.find(t => String(t._id) === String(newTask._id));
    console.log('Is in all tasks list?', !!foundTask);

    const dailyTasks = await getDailyTasks(lead.createdBy, 'admin');
    const foundDaily = dailyTasks.find(t => String(t._id) === String(newTask._id));
    console.log('Is in daily tasks list?', !!foundDaily);

    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
});

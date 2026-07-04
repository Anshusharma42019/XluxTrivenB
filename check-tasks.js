import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

const check = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URL);
    
    const Task = mongoose.model('Task', new mongoose.Schema({ title: String, status: String, department: String, dueDate: Date, assignedTo: mongoose.Schema.Types.ObjectId, isDeleted: Boolean, lead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' } }, { strict: false }));
    const Lead = mongoose.model('Lead', new mongoose.Schema({ name: String, status: String }, { strict: false }));
    
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end = new Date(); end.setHours(23, 59, 59, 999);
    
    const query = {
      isDeleted: false,
      dueDate: { $gte: start, $lte: end },
      status: { $nin: ['verification', 'cnp', 'cancel_call', 'cancelled', 'ready_to_shipment', 'interested', 'on_hold', 'closed_lost'] },
    };
    
    const hiddenLeadIds = await Lead.distinct('_id', { status: { $in: ['closed_lost', 'on_hold', 'follow_up'] }, isDeleted: { $ne: true } });
    if (hiddenLeadIds.length) {
      query.lead = { $nin: hiddenLeadIds };
    }
    
    const tasks = await Task.find(query).populate('lead', 'name status');
    
    let followUpLeads = 0;
    let callTitleTasks = 0;
    
    tasks.forEach(t => {
      if (t.lead && t.lead.status === 'follow_up') {
        followUpLeads++;
      }
      if (t.title && t.title.toLowerCase().includes('call again')) {
        callTitleTasks++;
      }
    });
    
    console.log('Total valid daily tasks:', tasks.length);
    console.log('Tasks with lead status = follow_up:', followUpLeads);
    console.log('Tasks with title = call again:', callTitleTasks);
    
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
};

check();

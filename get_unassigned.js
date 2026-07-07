
import('mongoose').then(async (mongoose) => {
  await mongoose.connect('mongodb://localhost:27017/xlux');
  const Order = mongoose.model('ShiprocketOrder', new mongoose.Schema({ status: String, lead_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' }, created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, billing_customer_name: String, problem: String, notes: String, platform: String }, { strict: false }));
  const ShipmaxxOrder = mongoose.model('ShipmaxxOrder', new mongoose.Schema({ status: String, lead_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' }, created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, billing_customer_name: String, problem: String, notes: String, platform: String }, { strict: false }));
  const User = mongoose.model('User', new mongoose.Schema({ name: String, role: String }, { strict: false }));
  
  // Find all delivered orders across ALL time for unassigned check
  const query = { status: { $in: ['DELIVERED', 'Delivered', 'delivered'] } };

  const o1 = await Order.find(query).populate('created_by').populate('lead_id').lean();
  const o2 = await ShipmaxxOrder.find(query).populate('created_by').populate('lead_id').lean();
  const allOrders = [...o1, ...o2];
  
  let count = 0;
  for (const o of allOrders) {
    const isAssigned = o.lead_id?.assignedTo || (o.created_by?.role === 'sales');
    if (!isAssigned) {
      if (count < 20) {
        console.log('UNASSIGNED:', o._id, 'Platform:', o.platform, 'Customer:', o.billing_customer_name, 'CreatedBy:', o.created_by?.name, 'Role:', o.created_by?.role, 'Notes:', o.notes);
      }
      count++;
    }
  }
  console.log('Total Unassigned Delivered Orders:', count);
  process.exit(0);
});


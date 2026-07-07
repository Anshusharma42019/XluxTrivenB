
import('mongoose').then(async (mongoose) => {
  await mongoose.connect('mongodb://localhost:27017/xlux');
  const Order = mongoose.model('ShiprocketOrder', new mongoose.Schema({ status: String, lead_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' }, created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, billing_customer_name: String, problem: String, notes: String, platform: String }, { strict: false }));
  const ShipmaxxOrder = mongoose.model('ShipmaxxOrder', new mongoose.Schema({ status: String, lead_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' }, created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, billing_customer_name: String, problem: String, notes: String, platform: String }, { strict: false }));
  const User = mongoose.model('User', new mongoose.Schema({ name: String, role: String }, { strict: false }));
  const Lead = mongoose.model('Lead', new mongoose.Schema({ name: String, assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' } }, { strict: false }));
  
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const monthEnd = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0, 23, 59, 59);

  const query = { 
    status: { $in: ['DELIVERED', 'Delivered', 'delivered'] },
    $or: [
      { delivered_at: { $gte: monthStart, $lte: monthEnd } },
      { delivered_at: null, status_updated_at: { $gte: monthStart, $lte: monthEnd } },
      { delivered_at: null, status_updated_at: null, createdAt: { $gte: monthStart, $lte: monthEnd } }
    ]
  };

  const o1 = await Order.find(query).populate('created_by').populate('lead_id').lean();
  const o2 = await ShipmaxxOrder.find(query).populate('created_by').populate('lead_id').lean();
  const allOrders = [...o1, ...o2];
  
  console.log('Total delivered:', allOrders.length);
  for (const o of allOrders) {
    const isAssigned = o.lead_id?.assignedTo || (o.created_by?.role === 'sales');
    if (!isAssigned) {
      console.log('UNASSIGNED:', o._id, 'Customer:', o.billing_customer_name, 'CreatedBy:', o.created_by?.name, 'Role:', o.created_by?.role, 'Lead Assigned To:', o.lead_id?.assignedTo);
    }
  }
  process.exit(0);
});


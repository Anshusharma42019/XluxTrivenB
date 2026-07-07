
import('mongoose').then(async (mongoose) => {
  await mongoose.connect('mongodb://localhost:27017/xlux');
  const Order = mongoose.model('ShiprocketOrder', new mongoose.Schema({ status: String, lead_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' }, created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, billing_customer_name: String }, { strict: false }));
  const User = mongoose.model('User', new mongoose.Schema({ name: String, role: String, isDeleted: Boolean }, { strict: false }));
  const users = await User.find({}).lean();
  console.log('Total Users:', users.length);
  const deletedUsers = users.filter(u => u.isDeleted);
  console.log('Deleted Users:', deletedUsers.length);
  process.exit(0);
});


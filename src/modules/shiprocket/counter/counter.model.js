import mongoose from 'mongoose';

const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
});

export const Counter = mongoose.model('Counter', counterSchema);

export const getNextOrderId = async () => {
  const counter = await Counter.findByIdAndUpdate(
    'order_id',
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return `ORD-${String(counter.seq).padStart(3, '0')}`;
};

export const peekNextOrderId = async () => {
  const counter = await Counter.findById('order_id');
  const next = (counter?.seq || 0) + 1;
  return `ORD-${String(next).padStart(3, '0')}`;
};

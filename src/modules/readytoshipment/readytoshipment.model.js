import mongoose from 'mongoose';

const readyToShipmentSchema = new mongoose.Schema(
  {
    task: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', required: true, unique: true },
    title: { type: String, required: true },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    lead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' },
    description: { type: String },
    cityVillageType: { type: String, enum: ['city', 'village'], default: 'city' },
    cityVillage: { type: String },
    houseNo: { type: String },
    postOffice: { type: String },
    district: { type: String },
    landmark: { type: String },
    pincode: { type: String },
    state: { type: String },
    problem: { type: String },
    age: { type: Number },
    weight: { type: Number },
    height: { type: Number },
    otherProblems: { type: String },
    problemDuration: { type: String },
    price: { type: Number },
    reminderAt: { type: Date },
    notes: [{ text: String, createdAt: { type: Date, default: Date.now } }],
    department: {
      type: String,
      enum: ['migraine', 'piles'],
      default: null,
    },
    sentToShiprocket: { type: Boolean, default: false },
  },
  { timestamps: true }
);

readyToShipmentSchema.index({ sentToShiprocket: 1, task: 1 });
readyToShipmentSchema.index({ createdAt: -1 });

export default mongoose.model('ReadyToShipment', readyToShipmentSchema);

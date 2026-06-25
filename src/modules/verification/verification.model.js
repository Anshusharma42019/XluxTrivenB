import mongoose from 'mongoose';

const verificationSchema = new mongoose.Schema(
  {
    task: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', required: true, unique: true },
    title: { type: String, required: true },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    lead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' },
    dueDate: { type: Date },
    cityVillageType: { type: String, enum: ['city', 'village'], default: 'city' },
    cityVillage: { type: String },
    houseNo: { type: String },
    postOffice: { type: String },
    district: { type: String },
    landmark: { type: String },
    pincode: { type: String },
    state: { type: String },
    address: { type: String },
    notes: [{ text: String, createdAt: { type: Date, default: Date.now } }],
    description: { type: String },
    reminderAt: { type: Date },
    problem: { type: String },
    age: { type: Number },
    weight: { type: Number },
    height: { type: Number },
    otherProblems: { type: String },
    problemDuration: { type: String },
    price: { type: Number },
    relief_percentage: { type: Number, default: null },
    department: {
      type: String,
      enum: ['migraine', 'piles'],
      default: null,
    },
    status: { type: String, enum: ['pending', 'verified', 'rejected', 'on_hold'], default: 'pending' },
    onHoldUntil: { type: Date },
    onHoldAt: { type: Date },
    onHoldReason: { type: String },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date },
  },
  { timestamps: true }
);

verificationSchema.index({ status: 1, createdAt: -1 });

export default mongoose.model('Verification', verificationSchema);

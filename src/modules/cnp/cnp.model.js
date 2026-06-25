import mongoose from 'mongoose';

const cnpSchema = new mongoose.Schema(
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
    department: {
      type: String,
      enum: ['migraine', 'piles'],
      default: null,
    },
    cnpCount: { type: Number, default: 1 },
    lastCnpAt: { type: Date, default: Date.now },
    cnpHistory: [{ clickedAt: { type: Date, default: Date.now } }],
  },
  { timestamps: true }
);

export default mongoose.model('Cnp', cnpSchema);

import mongoose from 'mongoose';

const callAgainSchema = new mongoose.Schema(
  {
    lead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', required: true },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    status: { type: String, enum: ['pending', 'contacted', 'interested', 'converted', 'closed_lost', 'done'], default: 'pending' },
    department: { type: String, enum: ['migraine', 'piles'] },
    notes: [{ text: String, createdAt: { type: Date, default: Date.now } }],
  },
  { timestamps: true }
);

callAgainSchema.index({ assignedTo: 1, updatedAt: -1 });
callAgainSchema.index({ department: 1, updatedAt: -1 });
callAgainSchema.index({ assignedTo: 1, department: 1, updatedAt: -1 });
callAgainSchema.index({ lead: 1 });

export default mongoose.model('CallAgain', callAgainSchema);

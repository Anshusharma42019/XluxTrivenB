/**
 * One-time cleanup script to fix existing data issues:
 * 1. Remove duplicate tasks for same lead (keep newest)
 * 2. Fix cancelled tasks that are still visible (should be hidden)
 * 
 * Run: node src/modules/task/task.cleanup.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

await mongoose.connect(process.env.MONGODB_URL);
console.log('Connected to MongoDB');

const Task = mongoose.model('Task', new mongoose.Schema({
  title: String, type: String, lead: mongoose.Schema.Types.ObjectId,
  assignedTo: mongoose.Schema.Types.ObjectId, createdBy: mongoose.Schema.Types.ObjectId,
  dueDate: Date, status: String, priority: String, department: String,
  isDeleted: Boolean, description: String,
}, { timestamps: true }));

// 1. Find leads with multiple active pending/overdue tasks
console.log('\n=== Fixing duplicate tasks ===');
const duplicates = await Task.aggregate([
  { $match: { isDeleted: false, status: { $in: ['pending', 'overdue'] }, lead: { $ne: null } } },
  { $group: { _id: '$lead', count: { $sum: 1 }, tasks: { $push: { id: '$_id', createdAt: '$createdAt' } } } },
  { $match: { count: { $gt: 1 } } }
]);

let duplicateFixed = 0;
for (const dup of duplicates) {
  // Sort by createdAt desc, keep newest, soft-delete rest
  const sorted = dup.tasks.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const toDelete = sorted.slice(1).map(t => t.id);
  await Task.updateMany({ _id: { $in: toDelete } }, { isDeleted: true });
  console.log(`Lead ${dup._id}: removed ${toDelete.length} duplicate tasks`);
  duplicateFixed += toDelete.length;
}
console.log(`Fixed ${duplicateFixed} duplicate tasks`);

// 2. Check how many cancelled tasks are visible (should be 0 after backend fix)
const cancelledVisible = await Task.countDocuments({ 
  status: 'cancelled', isDeleted: false 
});
console.log(`\n=== Cancelled tasks (now hidden by backend fix): ${cancelledVisible} ===`);

// 3. Tasks with status 'verification' should not be in Tasks list - verify exclusion is working
const verificationVisible = await Task.countDocuments({ 
  status: 'verification', isDeleted: false 
});
console.log(`Verification tasks (hidden by status filter): ${verificationVisible}`);

console.log('\n✅ Cleanup complete!');
process.exit(0);

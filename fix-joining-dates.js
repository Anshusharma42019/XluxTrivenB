/**
 * One-time fix script: Sets joiningDate = createdAt for all staff who don't have joiningDate set.
 * Run: node fix-joining-dates.js
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const MONGO_URI = process.env.MONGODB_URL || process.env.MONGO_URI || process.env.DB_URI;

await mongoose.connect(MONGO_URI);
console.log('Connected to MongoDB');

const result = await mongoose.connection.collection('users').updateMany(
  { joiningDate: { $exists: false }, isDeleted: { $ne: true } },
  [{ $set: { joiningDate: '$createdAt' } }]
);

console.log(`✅ Updated ${result.modifiedCount} users — joiningDate set to their createdAt date`);

// Show the results
const users = await mongoose.connection.collection('users').find(
  { isDeleted: { $ne: true }, role: { $ne: 'admin' } },
  { projection: { name: 1, role: 1, createdAt: 1, joiningDate: 1 } }
).toArray();

console.log('\n📋 All staff joining dates:');
users.forEach(u => {
  console.log(`  ${u.name} (${u.role}): Joined ${new Date(u.joiningDate).toLocaleDateString('en-IN')}`);
});

await mongoose.disconnect();
console.log('\nDone! ✅');

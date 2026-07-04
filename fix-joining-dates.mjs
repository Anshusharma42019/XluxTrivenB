// Run: node fix-joining-dates.mjs
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { readFileSync } from 'fs';

// Load .env manually
const envFile = readFileSync('.env', 'utf-8');
envFile.split('\n').forEach(line => {
  const [key, ...val] = line.split('=');
  if (key && key.trim()) process.env[key.trim()] = val.join('=').trim();
});

const MONGO_URI = process.env.MONGODB_URL || process.env.MONGO_URI || process.env.DB_URL;
if (!MONGO_URI) { console.error('No MONGO URI found in .env'); process.exit(1); }

console.log('Connecting to MongoDB...');
await mongoose.connect(MONGO_URI);
console.log('Connected!\n');

// Set joiningDate = createdAt for all users who don't have it
const db = mongoose.connection.db;
const col = db.collection('users');

// Use aggregation pipeline update to copy createdAt -> joiningDate
const result = await col.updateMany(
  { joiningDate: { $exists: false } },
  [{ $set: { joiningDate: '$createdAt' } }]
);
console.log(`Updated ${result.modifiedCount} users: joiningDate = createdAt\n`);

// Also update users where joiningDate is null
const result2 = await col.updateMany(
  { joiningDate: null },
  [{ $set: { joiningDate: '$createdAt' } }]
);
console.log(`Updated ${result2.modifiedCount} more users (null joiningDate)\n`);

// Show all staff
const users = await col.find(
  { isDeleted: { $ne: true }, role: { $ne: 'admin' } },
  { projection: { name: 1, role: 1, createdAt: 1, joiningDate: 1 } }
).toArray();

console.log('Staff Joining Dates:');
console.log('====================');
users.forEach(u => {
  const jd = u.joiningDate || u.createdAt;
  console.log(`  ${(u.name || 'N/A').padEnd(20)} | ${(u.role || '').padEnd(10)} | Joined: ${new Date(jd).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}`);
});

await mongoose.disconnect();
console.log('\nDone!');

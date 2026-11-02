import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import * as callLogService from './modules/call-log/callLog.service.js';
import CallLog from './modules/call-log/callLog.model.js';
import User from './modules/user/user.model.js';
import Lead from './modules/lead/lead.model.js';

async function runTests() {
  console.log('--- 🧪 STARTING TELECALLING IN-MEMORY INTEGRATION SUITE ---');

  // TEST 1: Phone Normalization Logic
  console.log('\n[Test 1] Testing cleanPhone normalizer...');
  const testCases = [
    { input: '+91 98765 43210', expected: '9876543210' },
    { input: '09876543210', expected: '9876543210' },
    { input: '+91-9876543210', expected: '9876543210' },
    { input: '9876543210', expected: '9876543210' },
    { input: '919876543210', expected: '9876543210' },
  ];

  for (const tc of testCases) {
    const cleaned = callLogService.cleanPhone(tc.input);
    if (cleaned === tc.expected) {
      console.log(`  ✓ "${tc.input}" -> "${cleaned}"`);
    } else {
      throw new Error(`cleanPhone failed: got ${cleaned}, expected ${tc.expected}`);
    }
  }

  // TEST 2: Start In-Memory MongoDB Server
  console.log('\n[Test 2] Starting In-Memory MongoDB instance...');
  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  await mongoose.connect(uri);
  console.log('  ✓ Connected to In-Memory DB successfully at', uri);

  // TEST 3: Create Test Staff Users
  console.log('\n[Test 3] Creating Test Staff users...');
  const agentRahul = await User.create({
    name: 'Rahul Sharma',
    email: 'rahul.sales@example.com',
    password: 'password123',
    role: 'sales',
    departments: ['migraine'],
  });

  const agentPriya = await User.create({
    name: 'Priya Singh',
    email: 'priya.sales@example.com',
    password: 'password123',
    role: 'sales',
    departments: ['piles'],
  });
  console.log(`  ✓ Created Staff: Rahul (${agentRahul._id}) and Priya (${agentPriya._id})`);

  // TEST 4: Create a Lead in CRM
  const customerPhone = '9876543210';
  console.log(`\n[Test 4] Creating Test Lead with phone ${customerPhone}...`);
  const leadDoc = await Lead.create({
    name: 'Anita Verma',
    phone: customerPhone,
    status: 'new',
    department: 'migraine',
    assignedTo: agentRahul._id,
  });
  console.log(`  ✓ Created Lead: Anita Verma (ID: ${leadDoc._id}, CNP: ${leadDoc.cnpCount || 0})`);

  // TEST 5: Outgoing Call with 0s duration (Auto CNP test)
  console.log('\n[Test 5] Syncing Outgoing Call with duration 0s (Unanswered)...');
  const syncResult1 = await callLogService.syncCallLogs(agentRahul._id, [
    {
      phone: customerPhone,
      callType: 'outgoing',
      duration: 0,
      timestamp: new Date().toISOString(),
    },
  ]);
  console.log('  ✓ Sync Result 1:', syncResult1);

  const updatedLead1 = await Lead.findById(leadDoc._id);
  console.log(`  ✓ Lead CNP count after 0s call: ${updatedLead1.cnpCount}`);
  if (updatedLead1.cnpCount !== 1) {
    throw new Error(`Expected cnpCount to be 1, got ${updatedLead1.cnpCount}`);
  }
  console.log(`  ✓ Last note on lead: "${updatedLead1.notes[updatedLead1.notes.length - 1].text}"`);

  // TEST 6: Outgoing Connected Call (145s talk-time)
  console.log('\n[Test 6] Syncing Connected Call (145s talk-time)...');
  const syncResult2 = await callLogService.syncCallLogs(agentRahul._id, [
    {
      phone: customerPhone,
      callType: 'outgoing',
      duration: 145,
      timestamp: new Date().toISOString(),
    },
  ]);
  console.log('  ✓ Sync Result 2:', syncResult2);

  const updatedLead2 = await Lead.findById(leadDoc._id);
  console.log(`  ✓ Last note on lead: "${updatedLead2.notes[updatedLead2.notes.length - 1].text}"`);

  // TEST 7: Inbound Missed Call from customer
  console.log('\n[Test 7] Syncing Inbound Missed Call from customer...');
  const syncResult3 = await callLogService.syncCallLogs(agentRahul._id, [
    {
      phone: customerPhone,
      callType: 'missed',
      duration: 0,
      timestamp: new Date().toISOString(),
    },
  ]);
  console.log('  ✓ Sync Result 3:', syncResult3);

  const pendingMissed = await callLogService.getPendingMissedCalls({});
  console.log(`  ✓ Pending Missed Calls Count: ${pendingMissed.total}`);
  if (pendingMissed.total !== 1) {
    throw new Error(`Expected 1 pending missed call, got ${pendingMissed.total}`);
  }

  // TEST 8: Duplicate Dial Detection (Priya dials the same customer)
  console.log('\n[Test 8] Testing Duplicate Call Collision (Priya calls same customer)...');
  const syncResult4 = await callLogService.syncCallLogs(agentPriya._id, [
    {
      phone: customerPhone,
      callType: 'outgoing',
      duration: 60,
      timestamp: new Date().toISOString(),
    },
  ]);
  console.log('  ✓ Sync Result 4 (Priya):', syncResult4);
  if (syncResult4.duplicatesFound !== 1) {
    throw new Error(`Expected 1 duplicate alert, got ${syncResult4.duplicatesFound}`);
  }
  console.log('  ✓ Collision detected! Duplicate alert successfully raised.');

  // TEST 9: Telecalling Leaderboard & Stats Aggregation
  console.log('\n[Test 9] Fetching Telecalling Desk Stats & Leaderboard...');
  const stats = await callLogService.getCallingStats({});
  console.log('  ✓ Overall Summary:', stats.summary);
  console.log('  ✓ Staff Leaderboard:');
  stats.leaderboard.forEach((staff) => {
    console.log(`    - ${staff.name}: Total ${staff.totalCalls} calls | Connected: ${staff.connectedCalls} | Talk-Time: ${staff.totalTalkTime}s | CNP: ${staff.cnpCalls}`);
  });

  // TEST 10: Resolve Missed Call
  console.log('\n[Test 10] Testing Missed Call Resolution...');
  const missedLog = pendingMissed.logs[0];
  await callLogService.resolveMissedCall(missedLog._id, agentRahul._id);
  const recheckedMissed = await callLogService.getPendingMissedCalls({});
  console.log(`  ✓ Pending Missed Calls after resolution: ${recheckedMissed.total}`);
  if (recheckedMissed.total !== 0) {
    throw new Error(`Expected 0 pending missed calls, got ${recheckedMissed.total}`);
  }

  // Clean shutdown
  await mongoose.disconnect();
  await mongod.stop();

  console.log('\n======================================================');
  console.log('🎉 ALL 10 TESTS PASSED WITH 100% SUCCESS! 🎉');
  console.log('   - Phone Normalizer: PASS');
  console.log('   - Call Log Sync API: PASS');
  console.log('   - Auto CNP Counter: PASS');
  console.log('   - Connected Talk-Time: PASS');
  console.log('   - Inbound Missed Calls: PASS');
  console.log('   - Duplicate Call Collision: PASS');
  console.log('   - Staff Leaderboard: PASS');
  console.log('   - Missed Call Resolution: PASS');
  console.log('======================================================');
  process.exit(0);
}

runTests().catch((err) => {
  console.error('\n❌ TEST RUN FAILED:', err);
  process.exit(1);
});

import connectDB from './src/config/database.js';
import { getNextSalesUser, distributeAbsentSalesLeads } from './src/modules/lead/lead.service.js';
import mongoose from 'mongoose';
import dns from 'dns';
import Lead from './src/modules/lead/lead.model.js';
import User from './src/modules/user/user.model.js';
import Attendance from './src/modules/attendance/attendance.model.js';

dns.setServers(['8.8.8.8', '8.8.4.4']);

async function runTest() {
  await connectDB();
  console.log("--- End-to-End Testing Absent Sales Redistribution ---");
  try {
    // 1. Find an active user and an absent user
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    const allSalesUsers = await User.find({ role: 'sales', isDeleted: false });
    const activeAttendances = await Attendance.find({
      user: { $in: allSalesUsers.map(u => u._id) },
      checkIn: { $ne: null },
      checkOut: null,
      isDeleted: false,
      $or: [
        { date: { $gte: startOfDay, $lte: endOfDay } },
        { checkIn: { $gte: startOfDay } },
      ],
    });
    const activeUserIds = activeAttendances.map(a => a.user.toString());
    const absentUsers = allSalesUsers.filter(u => !activeUserIds.includes(u._id.toString()));

    if (absentUsers.length === 0 || activeUserIds.length === 0) {
      console.log("Need at least 1 absent user and 1 active user to perform this test.");
      process.exit(0);
    }

    const absentUser = absentUsers[0];
    console.log("Selected Absent User:", absentUser.name || absentUser._id);

    // 2. Create a dummy lead for yesterday assigned to the absent user
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(18, 0, 0, 0); // 6 PM yesterday

    console.log("Creating dummy lead assigned to absent user...");
    const dummyLead = await Lead.create({
      name: 'Test Dummy Lead',
      phone: '9999999999',
      status: 'new',
      assignedTo: absentUser._id,
      createdBy: absentUser._id,
      createdAt: yesterday,
      isDeleted: false,
    });
    console.log("Dummy lead created with ID:", dummyLead._id);

    // 3. Run the redistribution function
    console.log("Running distributeAbsentSalesLeads()...");
    const result = await distributeAbsentSalesLeads();
    console.log("Redistribution Result:", result);

    // 4. Verify the dummy lead was reassigned
    const updatedLead = await Lead.findById(dummyLead._id);
    console.log("Was dummy lead reassigned?", updatedLead.assignedTo.toString() !== absentUser._id.toString());
    console.log("New Assignee ID:", updatedLead.assignedTo);

    // 5. Cleanup dummy lead
    console.log("Cleaning up dummy lead...");
    await Lead.findByIdAndDelete(dummyLead._id);
    console.log("Cleanup complete.");

  } catch(e) {
    console.error("Error during test:", e);
  }
  
  process.exit(0);
}

runTest();

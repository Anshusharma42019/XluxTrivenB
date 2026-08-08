import connectDB from './config/database.js';
import mongoose from 'mongoose';
import { Lead } from './modules/lead/lead.model.js';
import { InterestedLead, VerifiedOrder } from './modules/transition/statusModels.js';
import { transitionRecord } from './modules/transition/transition.service.js';

async function createLiveDemo() {
  console.log('⏳ Connecting to Database...');
  await connectDB();
  console.log('✅ Connected! Creating Live Demo Records for Verification...\n');

  try {
    // Demo 1: Lead -> Interested Lead
    const demoLead1 = await Lead.create({
      name: 'LIVE DEMO: Ramesh Kumar (Interested)',
      phone: '9876543211',
      cityVillage: 'Jaipur',
      state: 'Rajasthan',
      problem: 'Migraine for 2 years',
      department: 'migraine',
      price: 1800,
      source: 'other',
      status: 'new',
      notes: [{ text: 'Customer requested follow up on pricing and medicine course.' }]
    });

    console.log(`📌 [Step 1] Created raw lead in "leads" collection: ID = ${demoLead1._id}`);

    // Perform atomic transition to 'interested'
    await transitionRecord(Lead, demoLead1._id, 'interested', {
      relief_percentage: 40,
      note: 'Status updated to Interested via Demo Execution'
    });

    const verifyInterested = await InterestedLead.findById(demoLead1._id).lean();
    console.log('🚀 [Step 2] Successfully transitioned to "interestedleads" collection!');
    console.log('   📄 Document retrieved from "interestedleads":');
    console.log('      - Name:', verifyInterested.name);
    console.log('      - Phone:', verifyInterested.phone);
    console.log('      - Status:', verifyInterested.status);
    console.log('      - Transferred From:', verifyInterested.transferredFrom);
    console.log('      - Price & Relief:', `₹${verifyInterested.price} | Relief: ${verifyInterested.relief_percentage}%\n`);

    // Demo 2: Lead -> Verified Order
    const demoLead2 = await Lead.create({
      name: 'LIVE DEMO: Sunita Sharma (Verified Order)',
      phone: '9876543222',
      cityVillage: 'Bhopal',
      state: 'Madhya Pradesh',
      problem: 'Piles consultation and herbal pack',
      department: 'piles',
      price: 2499,
      source: 'other',
      status: 'new',
      notes: [{ text: 'Doctor verified consultation and approved dispatch.' }]
    });

    console.log(`📌 [Step 3] Created another lead in "leads" collection: ID = ${demoLead2._id}`);

    await transitionRecord(Lead, demoLead2._id, 'verified_order', {
      priority: 'high',
      note: 'Verified order ready for logistics packing'
    });

    const verifyOrder = await VerifiedOrder.findById(demoLead2._id).lean();
    console.log('🚀 [Step 4] Successfully transitioned to "verifiedorders" collection!');
    console.log('   📄 Document retrieved from "verifiedorders":');
    console.log('      - Name:', verifyOrder.name);
    console.log('      - Phone:', verifyOrder.phone);
    console.log('      - Status:', verifyOrder.status);
    console.log('      - Department:', verifyOrder.department);
    console.log('      - Priority:', verifyOrder.priority);
    console.log('\n🌟 Both records have been permanently created and stored in your live database!');
    console.log('💡 You can check MongoDB Compass or your app right now to inspect them.');

  } catch (err) {
    console.error('❌ Error creating live demo data:', err);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

createLiveDemo();

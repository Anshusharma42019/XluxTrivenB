require('dotenv').config();
const mongoose = require('mongoose');

mongoose.connect(process.env.MONGODB_URL).then(async () => {
  try {
    const waCount = await mongoose.connection.collection('leads').countDocuments({ source: 'social_media' });
    console.log('Social Media Leads:', waCount);
    
    const noteCount = await mongoose.connection.collection('leads').countDocuments({ 'notes.text': { $regex: /\[Interakt Message\]/ } });
    console.log('Interakt Note Leads:', noteCount);
    
    const allCount = await mongoose.connection.collection('leads').countDocuments({});
    console.log('Total Leads:', allCount);
    
  } catch (err) {
    console.error(err);
  } finally {
    process.exit(0);
  }
});

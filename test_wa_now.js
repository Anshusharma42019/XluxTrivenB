import { sendWhatsAppMessage } from './src/modules/interakt/interakt.service.js';
import dotenv from 'dotenv';
dotenv.config();

const phone = '6201416713';
const templateName = process.env.INTERAKT_1ST_FOLLOWUP_TEMPLATE || '1st_followup';
const customerName = 'Test Customer';

console.log(`Sending test message to ${phone}...`);
console.log(`Template: ${templateName}`);
console.log(`API Key: ${process.env.INTERAKT_API_KEY ? 'Present' : 'Missing'}`);

sendWhatsAppMessage({
  phone,
  templateName,
  languageCode: 'en',
  bodyValues: [customerName]
}).then(res => {
  console.log('Success:', res);
  process.exit(0);
}).catch(err => {
  console.error('Error Status:', err.response?.status);
  console.error('Error Details:', JSON.stringify(err.response?.data, null, 2));
  process.exit(1);
});

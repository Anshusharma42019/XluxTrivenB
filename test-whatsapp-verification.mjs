// Final test: send WhatsApp with 5 variables to 9117140080
import { config } from 'dotenv'; config();
import https from 'https';

const KEY = process.env.INTERAKT_API_KEY;
const TEMPLATE = process.env.INTERAKT_VERIFICATION_TEMPLATE || 'booking_';
const LANG = process.env.INTERAKT_VERIFICATION_LANG || 'hi';

const phone = '9117140080';
const bodyValues = [
  'Anshu Sharma',        // {{1}}
  'सिर दर्द एवं माइग्रेन', // {{2}}
  '1499',               // {{3}}
  'H.No. 45, Ram Nagar, Lucknow, UP - 226001', // {{4}}
  'Triven Ayurveda'     // {{5}}
];

const payload = JSON.stringify({
  countryCode: '+91',
  phoneNumber: phone,
  callbackData: 'crm_test',
  type: 'Template',
  template: { name: TEMPLATE, languageCode: LANG, bodyValues },
});

console.log(`Sending to ${phone} via template "${TEMPLATE}" (${LANG})`);
console.log('bodyValues:', bodyValues);

const options = {
  hostname: 'api.interakt.ai',
  path: '/v1/public/message/',
  method: 'POST',
  headers: {
    'Authorization': `Basic ${KEY}`,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  },
  timeout: 20000,
};

const req = https.request(options, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log('\nStatus:', res.statusCode);
    const parsed = JSON.parse(data);
    if (parsed.result) {
      console.log('✅ SUCCESS! Message sent! ID:', parsed.id);
      console.log('Check WhatsApp on +91', phone);
    } else {
      console.log('❌ FAILED:', parsed.message);
    }
  });
});

req.on('error', (e) => console.error('❌ Error:', e.message));
req.on('timeout', () => { console.error('❌ Timeout'); req.destroy(); });
req.write(payload);
req.end();

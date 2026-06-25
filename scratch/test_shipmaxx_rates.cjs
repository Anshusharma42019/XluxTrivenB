const axios = require('axios');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const email = process.env.SHIPMAXX_EMAIL;
const password = process.env.SHIPMAXX_PASSWORD;
const authUrl = process.env.SHIPMAXX_AUTH_URL || 'https://appapi.losung360.com/external/v1';

async function run() {
  try {
    const loginRes = await axios.post(`${authUrl}/auth/login`, { email_id: email, password: password });
    const token = loginRes.data.access_token;
    
    // Attempt to get shipping rates / carriers
    try {
      const res = await axios.post(`${authUrl}/shipping/rate-calculator`, {
        pickup_pincode: 208019, // Kanpur
        delivery_pincode: 400001, // Mumbai
        weight: 1,
        payment_method: 'prepaid'
      }, {
        headers: { Authorization: `Bearer ${token}` }
      });
      console.log('RATES POST:', JSON.stringify(res.data, null, 2));
    } catch(e) {
      console.log('RATES POST ERROR:', e.response ? e.response.data : e.message);
    }
  } catch (err) {
    console.error('Login error:', err.response ? err.response.data : err.message);
  }
}
run();

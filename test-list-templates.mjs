import { config } from 'dotenv'; config();
import axios from 'axios';
const KEY = process.env.INTERAKT_API_KEY;
try {
  const res = await axios.get('https://api.interakt.ai/v1/public/track/organization/templates', {
    headers: { Authorization: `Basic ${KEY}`, 'Content-Type': 'application/json' }
  });
  // Print full raw response to see exact structure
  console.log('Full Response:', JSON.stringify(res.data, null, 2));
} catch(e) {
  console.error('Error:', e?.response?.status, JSON.stringify(e?.response?.data || e.message, null, 2));
}

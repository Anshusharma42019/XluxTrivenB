import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

const test = async () => {
  try {
    const loginRes = await axios.post(process.env.SHIPMAXX_AUTH_URL + '/auth/login', {
      email_id: process.env.SHIPMAXX_EMAIL,
      password: process.env.SHIPMAXX_PASSWORD
    });
    const token = loginRes.data.access_token;
    
    const trackRes = await axios.get(process.env.SHIPMAXX_BASE_URL + '/shipping/track-shipment?awb=77850890515', {
      headers: { Authorization: `Bearer ${token}` }
    });
    
    console.log(JSON.stringify(trackRes.data, null, 2));
  } catch(e) { console.error(e.response ? e.response.data : e.message); }
};
test();

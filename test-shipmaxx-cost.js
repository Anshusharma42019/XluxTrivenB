import axios from 'axios';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const test = async () => {
  try {
    const loginRes = await axios.post(process.env.SHIPMAXX_AUTH_URL + '/auth/login', {
      email_id: process.env.SHIPMAXX_EMAIL,
      password: process.env.SHIPMAXX_PASSWORD
    });
    const token = loginRes.data.data.token || loginRes.data.token;
    
    const ordersRes = await axios.get(process.env.SHIPMAXX_BASE_URL + '/orders?limit=5', {
      headers: { Authorization: `Bearer ${token}` }
    });
    
    console.log("Order 1:", JSON.stringify(ordersRes.data.data.data[0], null, 2));

    const shipRes = await axios.get(process.env.SHIPMAXX_BASE_URL + '/shipping/shipments?limit=5', {
      headers: { Authorization: `Bearer ${token}` }
    });
    
    console.log("Shipment 1:", JSON.stringify(shipRes.data.data.data[0], null, 2));
    
  } catch(e) { console.error(e.response ? e.response.data : e.message); }
};
test();

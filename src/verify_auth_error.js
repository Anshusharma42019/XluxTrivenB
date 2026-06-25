import dns from 'dns';
dns.setServers(['8.8.8.8', '8.8.4.4']);

import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import axios from 'axios';
import { User } from './modules/user/user.model.js';

const MONGODB_URL = 'mongodb+srv://anshusharma42019:Anshu42019@cluster0.bubhmal.mongodb.net/Try-dtabase?appName=Cluster0';
const JWT_SECRET = 'trivenAyurveda';

async function test() {
  console.log('Connecting to database...');
  await mongoose.connect(MONGODB_URL);
  console.log('Connected!');

  const user = await User.findOne({ isDeleted: false });
  if (!user) {
    console.error('No user found in database!');
    process.exit(1);
  }
  console.log(`Found user: ${user.email} (Role: ${user.role})`);

  const expires = new Date();
  expires.setMinutes(expires.getMinutes() + 60);

  const payload = {
    sub: user._id,
    role: user.role,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(expires.getTime() / 1000),
    type: 'access',
  };

  const token = jwt.sign(payload, JWT_SECRET);
  console.log(`Generated JWT Token: ${token}`);

  console.log('Fetching /integrations/setPassword from backend...');
  try {
    const res = await axios.post('http://localhost:5000/api/v1/integrations/setPassword', {
      email: 'infotriven@gmail.com',
      password: 'Triven123$'
    }, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
    console.log('Auth Login Success!', res.status, res.data);
  } catch (err) {
    console.error('Auth Login Failed:', err.response?.status, err.response?.data || err.message);
  }

  await mongoose.disconnect();
}

test();

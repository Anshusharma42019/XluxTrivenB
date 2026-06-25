import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

config({ path: path.join(__dirname, '.env') });

async function run() {
  try {
    await mongoose.connect(process.env.MONGODB_URL);
    console.log('Connected to MongoDB');

    const db = mongoose.connection.db;
    const admin = await db.collection('users').findOne({ role: 'admin', isDeleted: false });

    if (!admin) {
      console.log('No admin found');
      process.exit(1);
    }

    const payload = {
      sub: admin._id.toString(),
      role: admin.role,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
      type: 'access',
    };
    
    // Check .env for secret. In our file it's <your_jwt_secret> unless changed.
    const secret = process.env.JWT_SECRET || '<your_jwt_secret>';
    const token = jwt.sign(payload, secret);
    
    console.log('Generated Token:', token);

    const res = await fetch('http://localhost:5000/api/v1/leads/distribute-unassigned', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      }
    });

    const data = await res.json();
    console.log('API Response Status:', res.status);
    console.log('API Response Body:', data);
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await mongoose.disconnect();
  }
}

run();

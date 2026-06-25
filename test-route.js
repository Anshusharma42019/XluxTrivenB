const axios = require('axios');

async function testFrontendEndpoint() {
  try {
    // Read token from environment or simulate login
    const loginRes = await axios.post('http://localhost:5000/api/v1/auth/login', {
      email: 'infotriven@gmail.com', // wait, admin user for CRM
      password: 'password123'
    });
    // This might fail if I don't know the admin CRM password.
    // Let me just test the backend endpoint directly instead by modifying the backend controller temporarily to log it.
  } catch (err) {
    console.error(err.message);
  }
}

testFrontendEndpoint();

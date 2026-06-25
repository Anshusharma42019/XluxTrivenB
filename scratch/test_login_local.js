const path = require('path');
const https = require('https');
const url = require('url');

// Load env from backend
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const email_id = process.env.SHIPMAXX_EMAIL;
const password = process.env.SHIPMAXX_PASSWORD;
const baseUrl = process.env.SHIPMAXX_BASE_URL;

console.log('Parsed Env Variables:');
console.log('  Base URL:', baseUrl);
console.log('  Email:', email_id);
console.log('  Password Length:', password ? password.length : 0);
console.log('  Password Ends With $:', password ? password.endsWith('$') : false);
console.log('  Password Has Quotes:', password ? (password.startsWith("'") || password.endsWith("'")) : false);

function post(targetUrl, body) {
  return new Promise((resolve) => {
    const parsed = url.parse(targetUrl);
    const postData = JSON.stringify(body);
    
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 5000
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, body: data });
      });
    });

    req.on('error', (err) => resolve({ status: 'ERROR', body: err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 'TIMEOUT', body: '' });
    });
    
    req.write(postData);
    req.end();
  });
}

async function run() {
  const fullUrl = `${baseUrl}/auth/login`;
  console.log(`\nTesting connection with parsed credentials to: ${fullUrl}`);
  const res = await post(fullUrl, { email_id, password });
  console.log(`Response status: ${res.status}`);
  console.log(`Response body: ${res.body}`);

  // Test without single quotes if they are present in the password
  if (password && (password.startsWith("'") || password.endsWith("'"))) {
    const strippedPassword = password.replace(/^'|'$/g, '');
    console.log(`\nTesting with quotes stripped from password (${strippedPassword}):`);
    const res2 = await post(fullUrl, { email_id, password: strippedPassword });
    console.log(`Response status: ${res2.status}`);
    console.log(`Response body: ${res2.body}`);
  }
}

run();

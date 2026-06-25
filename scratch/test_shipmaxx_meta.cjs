const path = require('path');
const https = require('https');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const email_id = process.env.SHIPMAXX_EMAIL;
const password  = process.env.SHIPMAXX_PASSWORD;
const authUrl   = process.env.SHIPMAXX_AUTH_URL;
const baseUrl   = process.env.SHIPMAXX_BASE_URL;

function req(method, targetUrl, body, token) {
  return new Promise((resolve) => {
    const u = new URL(targetUrl);
    const postData = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (token)    headers['Authorization'] = `Bearer ${token}`;
    if (postData) headers['Content-Length'] = Buffer.byteLength(postData);
    const r = https.request({ hostname: u.hostname, port: 443, path: u.pathname + u.search, method, headers, timeout: 8000 }, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ s: res.statusCode, b: d }));
    });
    r.on('error', e => resolve({ s: 'ERR', b: e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ s: 'TIMEOUT', b: '' }); });
    if (postData) r.write(postData);
    r.end();
  });
}

async function probe(token, endpoint) {
  console.log(`\nGET ${baseUrl}${endpoint}`);
  const r = await req('GET', `${baseUrl}${endpoint}`, null, token);
  console.log('Status:', r.s);
  if (r.s === 200 || r.s === 201) {
    try {
      console.log(JSON.stringify(JSON.parse(r.b), null, 2).substring(0, 500));
    } catch {
      console.log(r.b.substring(0, 500));
    }
  } else {
    console.log(r.b.substring(0, 200));
  }
}

async function run() {
  console.log('Logging in...');
  const lr = await req('POST', `${authUrl}/auth/login`, { email_id, password });
  if (lr.s !== 200) { console.log('Login failed:', lr.b); return; }
  const token = JSON.parse(lr.b).access_token;
  
  await probe(token, '/channels');
  await probe(token, '/channel');
  await probe(token, '/pickup-addresses');
  await probe(token, '/pickup_addresses');
  await probe(token, '/warehouses');
  await probe(token, '/facilities');
}

run().catch(console.error);

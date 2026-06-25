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

async function run() {
  const orderId = process.argv[2];
  if (!orderId) {
    console.log('Usage: node test_orders.cjs <order_id>');
    console.log('Example: node test_orders.cjs 528001');
    return;
  }

  console.log('\n[1] Logging in...');
  const lr = await req('POST', `${authUrl}/auth/login`, { email_id, password });
  if (lr.s !== 200) { console.log('Login failed:', lr.b); return; }
  const token = JSON.parse(lr.b).access_token;
  console.log('    Token OK ✓');

  console.log(`\n[2] GET ${baseUrl}/orders/${orderId}`);
  const r = await req('GET', `${baseUrl}/orders/${orderId}`, null, token);
  console.log('    Status:', r.s);
  try {
    console.log(JSON.stringify(JSON.parse(r.b), null, 2));
  } catch {
    console.log(r.b);
  }
}

run().catch(console.error);

const https = require('https');

function test(path, method, body, contentType) {
  return new Promise(r => {
    const b = body;
    const opts = {
      hostname: 'app.shipmaxx.in', port: 443,
      path, method,
      headers: {
        'Content-Type': contentType,
        'Accept': 'application/json, text/plain, */*',
        'Content-Length': Buffer.byteLength(b),
        'User-Agent': 'Mozilla/5.0',
      }
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        console.log('STATUS:', res.statusCode);
        console.log('HEADERS:', JSON.stringify(res.headers));
        console.log('BODY:', d.substring(0, 500));
      });
    });
    req.on('error', e => console.log('ERROR:', e.message));
    req.write(b);
    req.end();
  });
}

const em = 'infotriven@gmail.com';
const pw = 'Triven123$';

(async () => {
  console.log('\n=== TEST 1: JSON email+password ===');
  await test('/api/external/v1/auth/login', 'POST',
    JSON.stringify({ email: em, password: pw }),
    'application/json'
  );

  console.log('\n=== TEST 2: form-urlencoded ===');
  await test('/api/external/v1/auth/login', 'POST',
    `email=${encodeURIComponent(em)}&password=${encodeURIComponent(pw)}`,
    'application/x-www-form-urlencoded'
  );

  console.log('\n=== TEST 3: JSON email_id+password ===');
  await test('/api/external/v1/auth/login', 'POST',
    JSON.stringify({ email_id: em, password: pw }),
    'application/json'
  );

  // Check what the login PAGE looks like (GET)
  console.log('\n=== TEST 4: GET login page ===');
  await test('/login', 'GET', '', 'text/html');
})();

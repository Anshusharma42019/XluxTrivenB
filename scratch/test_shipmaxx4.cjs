const https = require('https');

const em = 'infotriven@gmail.com';
const pw = 'Triven123$';
const basic = Buffer.from(`${em}:${pw}`).toString('base64');

console.log('Basic Auth header:', `Basic ${basic}`);

function test(path, method, body, headers) {
  return new Promise(r => {
    const b = body ? JSON.stringify(body) : '';
    const opts = {
      hostname: 'app.shipmaxx.in', port: 443,
      path, method,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0',
        ...headers,
        ...(b && { 'Content-Length': Buffer.byteLength(b), 'Content-Type': 'application/json' }),
      }
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => r('STATUS:' + res.statusCode + ' | ' + d.substring(0, 500)));
    });
    req.on('error', e => r('ERROR:' + e.message));
    if (b) req.write(b);
    req.end();
  });
}

(async () => {
  console.log('\n=== Basic Auth POST /auth/login (empty body) ===');
  console.log(await test('/api/external/v1/auth/login', 'POST', null, { Authorization: `Basic ${basic}` }));

  console.log('\n=== Basic Auth GET /auth/login ===');
  console.log(await test('/api/external/v1/auth/login', 'GET', null, { Authorization: `Basic ${basic}` }));

  console.log('\n=== Basic Auth POST /auth/token ===');
  console.log(await test('/api/external/v1/auth/token', 'POST', null, { Authorization: `Basic ${basic}` }));

  console.log('\n=== Basic Auth POST /auth/login with body ===');
  console.log(await test('/api/external/v1/auth/login', 'POST', { email: em, password: pw }, { Authorization: `Basic ${basic}` }));
})();

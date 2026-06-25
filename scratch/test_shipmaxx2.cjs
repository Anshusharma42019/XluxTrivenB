const https = require('https');

function test(path, method, body) {
  return new Promise(r => {
    const b = body ? JSON.stringify(body) : '';
    const opts = {
      hostname: 'app.shipmaxx.in', port: 443,
      path, method,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...(b && { 'Content-Length': Buffer.byteLength(b) })
      }
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => r('STATUS:' + res.statusCode + ' BODY:' + d.substring(0, 500)));
    });
    req.on('error', e => r('ERROR:' + e.message));
    if (b) req.write(b);
    req.end();
  });
}

const pw = 'Triven123$';
const em = 'infotriven@gmail.com';

(async () => {
  const endpoints = [
    ['/api/external/v1/auth/login',     'POST', { email: em, password: pw }],
    ['/api/external/v1/login',          'POST', { email: em, password: pw }],
    ['/api/v1/auth/login',              'POST', { email: em, password: pw }],
    ['/api/external/v1/auth/login',     'POST', { email_id: em, password: pw }],
    ['/api/external/v1/auth/token',     'POST', { email: em, password: pw }],
  ];
  for (const [p, m, b] of endpoints) {
    console.log(`\n${m} ${p}`);
    console.log(await test(p, m, b));
  }
})();

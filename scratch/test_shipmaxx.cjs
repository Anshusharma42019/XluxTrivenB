const https = require('https');

const combos = [
  { email: 'infotriven@gmail.com', password: 'Triven123$' },
  { email_id: 'infotriven@gmail.com', password: 'Triven123$' },
  { username: 'infotriven@gmail.com', password: 'Triven123$' },
  { email: 'infotriven@gmail.com', password: 'Triven123$', remember: true },
];

function test(body) {
  return new Promise(r => {
    const b = JSON.stringify(body);
    const req = https.request({
      hostname: 'app.shipmaxx.in', port: 443,
      path: '/api/external/v1/auth/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => r('STATUS:' + res.statusCode + ' BODY:' + d.substring(0, 400)));
    });
    req.on('error', e => r('ERROR:' + e.message));
    req.write(b);
    req.end();
  });
}

(async () => {
  for (const c of combos) {
    console.log('\nPayload:', JSON.stringify(c));
    console.log('Result:', await test(c));
  }
})();

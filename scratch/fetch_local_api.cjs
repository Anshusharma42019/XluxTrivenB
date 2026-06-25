const http = require('http');

const options = {
  hostname: 'localhost',
  port: 5000,
  path: '/api/v1/shiprocket/orders',
  method: 'GET',
  headers: {
    'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI2YTI3YjYzYzFhNzk5OTcxZGEwNWMyMDUiLCJyb2xlIjoiYWRtaW4iLCJpYXQiOjE3ODEwODQwNTAsImV4cCI6MTc4MzY3NjA1MCwidHlwZSI6ImFjY2VzcyJ9.OhsmgjPKwZRUDV0N3y43IKUPbFrQ9R3H0KN4ErVSNok'
  }
};

const req = http.request(options, res => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    try {
      const json = JSON.parse(data);
      const orders = json.data || json.data?.data || [];
      const smxOrders = Array.isArray(orders) ? orders.filter(o => o.platform === 'shipmaxx') : [];
      if (smxOrders.length) {
         console.log('Found ShipMaxx orders:', smxOrders.length);
         smxOrders.slice(0, 5).forEach(o => {
             console.log(`Order: ${o.order_id}, channel_id: ${o.channel_id}, pickup_address_id: ${o.pickup_address_id}, warehouse_id: ${o.warehouse_id}`);
         });
      } else {
         console.log('No shipmaxx orders found in the response.');
         if (orders.length > 0) {
             console.log(`First order platform: ${orders[0].platform}`);
         }
      }
    } catch(e) {
      console.log('Error parsing:', e.message);
      console.log(data.substring(0, 500));
    }
  });
});

req.on('error', e => console.error(e));
req.end();

const fs = require('fs');
const appendCode = `
export const debugBackfillDelivered = catchAsync(async (req, res) => {
  const orders = await Order.find({ platform: 'shipmaxx', status: { $in: [/^delivered$/i, /^rto_delivered$/i, /^DEL$/i, /^RTO$/i] }, delivered_at: { $exists: false } }).limit(500);
  let fixed = 0;
  for (const o of orders) {
    try {
      const trackRes = await smx.trackShipment(o.awb_code);
      const tracking = trackRes?.data?.data || trackRes?.data || trackRes || {};
      let actualDeliveredAt = null;
      if (tracking.history && Array.isArray(tracking.history)) {
        const delEvent = tracking.history.find(h => h.system_status_code === 'DEL' || (h.system_status_name || '').toLowerCase() === 'delivered' || (h.status || '').toLowerCase() === 'delivered');
        if (delEvent) {
          const dStr = delEvent.date || delEvent.timestamp || delEvent.time;
          if (dStr) {
            const pd = parseShipMaxxDate(dStr);
            if (pd && !isNaN(pd.getTime())) actualDeliveredAt = pd;
          }
        }
      }
      if (actualDeliveredAt) {
        o.delivered_at = actualDeliveredAt;
        o.status_updated_at = actualDeliveredAt;
        await o.save();
        fixed++;
      }
    } catch(err) {
      console.error(err);
    }
  }
  res.json({ checked: orders.length, fixed });
});
`;
fs.appendFileSync('src/modules/shipmaxx/shipmaxx.controller.js', appendCode);
console.log('Appended debugBackfillDelivered to shipmaxx.controller.js');

import cron from 'node-cron';
import { Followup as ShiprocketFollowup } from '../shiprocket/models/followup.model.js';
import { Order as ShiprocketOrder } from '../shiprocket/models/order.model.js';
import { ShipmaxxFollowup } from '../shipmaxx/models/shipmaxxFollowup.model.js';
import { ShipmaxxOrder } from '../shipmaxx/models/shipmaxxOrder.model.js';
import { sendWhatsAppMessage } from '../interakt/interakt.service.js';

const processFollowups = async () => {
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

  const templateName = process.env.INTERAKT_1ST_FOLLOWUP_TEMPLATE;
  if (!templateName) {
    console.log('[FollowupCron] INTERAKT_1ST_FOLLOWUP_TEMPLATE not set in .env. Skipping messages.');
    return;
  }

  // Shiprocket
  const srFollowups = await ShiprocketFollowup.find({
    followup_number: 1,
    scheduled_date: { $lte: todayEnd },
    completed: false,
    auto_message_sent: { $ne: true }
  });

  for (const fu of srFollowups) {
    try {
      const order = await ShiprocketOrder.findById(fu.order_id).select('billing_phone billing_customer_name');
      if (order && order.billing_phone) {
        await sendWhatsAppMessage({
          phone: order.billing_phone,
          templateName: templateName,
          languageCode: 'en',
          bodyValues: [order.billing_customer_name || 'Customer']
        });
        fu.auto_message_sent = true;
        await fu.save();
      }
    } catch (err) {
      console.error('[Shiprocket 1st Followup Cron Error]', err.message);
    }
  }

  // Shipmaxx
  const smxFollowups = await ShipmaxxFollowup.find({
    followup_number: 1,
    scheduled_date: { $lte: todayEnd },
    completed: false,
    auto_message_sent: { $ne: true }
  });

  for (const fu of smxFollowups) {
    try {
      const order = await ShipmaxxOrder.findById(fu.order_id).select('billing_phone billing_customer_name');
      if (order && order.billing_phone) {
        await sendWhatsAppMessage({
          phone: order.billing_phone,
          templateName: templateName,
          languageCode: 'en',
          bodyValues: [order.billing_customer_name || 'Customer']
        });
        fu.auto_message_sent = true;
        await fu.save();
      }
    } catch (err) {
      console.error('[Shipmaxx 1st Followup Cron Error]', err.message);
    }
  }
};

const initFollowupCron = () => {
  // Run every day at 10:00 AM
  cron.schedule('0 10 * * *', async () => {
    console.log('[FollowupCron] Running daily 1st followup automated messages...');
    await processFollowups();
    console.log('[FollowupCron] Completed daily 1st followup automated messages.');
  });

  // Also run every hour just in case new ones pop up
  cron.schedule('0 * * * *', async () => {
     await processFollowups();
  });
};

export default initFollowupCron;

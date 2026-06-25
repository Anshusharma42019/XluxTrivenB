import app from './app.js';
import { config } from './config/config.js';
import connectDB from './config/database.js';
import initAttendanceCron from './modules/attendance/attendance.cron.js';
import smx from './modules/shipmaxx/shipmaxx.service.js';
import dns from 'dns';

dns.setServers(['8.8.8.8', '8.8.4.4']);

// Vercel serverless: connect DB on each cold start, then export app
const initPromise = connectDB().then(async () => {
  initAttendanceCron();
  try {
    await smx.login();
    console.log('[ShipMaxx] Token pre-loaded on startup ✓');
  } catch (err) {
    console.warn('[ShipMaxx] Startup pre-login failed (will retry on first request):', err.message);
  }
});

// Wrap app so DB is always ready before handling requests
const handler = async (req, res) => {
  await initPromise;
  app(req, res);
};

// Local dev: start HTTP server directly
if (process.env.VERCEL !== '1') {
  initPromise.then(() => {
    app.listen(config.port, () => {
      console.log(`Server listening on port ${config.port} in ${config.env} mode`);
    });
  });
}

export default handler;

import cron from 'node-cron';
import { distributeUnassignedLeads, distributeAbsentSalesLeads } from './lead.service.js';

/**
 * Initialize cron jobs for lead auto-distribution.
 */
const initLeadCron = () => {
  // ─── 9:00 AM IST: Distribute all unassigned night leads ───────────────────
  // Raat ko jo leads aaye aur koi check-in nahi tha, unhe subha distribute karo
  cron.schedule('30 3 * * *', async () => {
    // 3:30 AM UTC = 9:00 AM IST
    console.log('[LeadCron] 9:00 AM IST — Distributing unassigned night leads...');
    try {
      const result = await distributeUnassignedLeads(null);
      console.log(`[LeadCron] Night lead distribution done: ${result.message}`);
    } catch (err) {
      console.error('[LeadCron] Night lead distribution failed:', err.message);
    }
  }, { timezone: 'UTC' });

  // ─── 11:30 AM IST: Redistribute absent sales staff leads ───────────────────
  // Jo sales aaj check-in nahi aaya, uske leads baaki active sales mein distribute karo
  cron.schedule('0 6 * * *', async () => {
    // 6:00 AM UTC = 11:30 AM IST
    console.log('[LeadCron] 11:30 AM IST — Redistributing absent sales leads...');
    try {
      const result = await distributeAbsentSalesLeads();
      console.log(`[LeadCron] Absent sales redistribution done: ${result.message}`);
    } catch (err) {
      console.error('[LeadCron] Absent sales redistribution failed:', err.message);
    }
  }, { timezone: 'UTC' });

  console.log('[LeadCron] Lead distribution cron jobs scheduled (9:00 AM + 11:30 AM IST)');
};

export default initLeadCron;

import cron from 'node-cron';
import attendanceService from './attendance.service.js';

/**
 * Initialize cron jobs for attendance.
 */
const initAttendanceCron = () => {
  // Check every hour for users who have been checked in for > 10 hours
  // '0 * * * *' runs at the start of every hour
  cron.schedule('0 * * * *', async () => {
    console.log('[Cron] Checking for overdue check-ins (10h+)...');
    try {
      const count = await attendanceService.autoCheckOutByDuration(10);
      if (count > 0) {
        console.log(`[Cron] Auto check-out completed. Processed ${count} users.`);
      }
    } catch (error) {
      console.error('[Cron] Auto check-out failed:', error.message);
    }
  });

  // Also keep a final cleanup at 11:59 PM just in case anyone is left
  cron.schedule('59 23 * * *', async () => {
    console.log('[Cron] Running EOD cleanup...');
    try {
      await attendanceService.autoCheckOutByDuration(0); // Force check-out everyone remaining
    } catch (error) {
      console.error('[Cron] EOD cleanup failed:', error.message);
    }
  }, { timezone: 'Asia/Kolkata' });

  console.log('[Cron] Attendance jobs scheduled (Hourly 10h check + EOD cleanup)');
};

export default initAttendanceCron;


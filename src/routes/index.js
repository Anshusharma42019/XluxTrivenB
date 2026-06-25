import express from 'express';
import authRoute from '../modules/auth/auth.routes.js';
import userRoute from '../modules/user/user.routes.js';
import leadRoute from '../modules/lead/lead.routes.js';
import taskRoute from '../modules/task/task.routes.js';
import notificationRoute from '../modules/notification/notification.routes.js';
import dashboardRoute from '../modules/dashboard/dashboard.routes.js';
import cnpRoute from '../modules/cnp/cnp.routes.js';
import callAgainRoute from '../modules/callagain/callagain.routes.js';
import verificationRoute from '../modules/verification/verification.routes.js';
import readyToShipmentRoute from '../modules/readytoshipment/readytoshipment.routes.js';
import shiprocketRoute from '../modules/shiprocket/shiprocket.routes.js';
import attendanceRoute from '../modules/attendance/attendance.routes.js';
import appointmentRoute from '../modules/appointment/appointment.routes.js';
import searchRoute from '../modules/search/search.routes.js';
import commissionRoute from '../modules/commission/commission.routes.js';
import interaktRoute from '../modules/interakt/interakt.routes.js';
import shipmaxxRoute from '../modules/shipmaxx/shipmaxx.routes.js';
import integrationsRoute from '../modules/integrations/integrations.routes.js';

const router = express.Router();
// Define all the routes for the application

const defaultRoutes = [
  { path: '/auth', route: authRoute },
  { path: '/users', route: userRoute },
  { path: '/leads', route: leadRoute },
  { path: '/tasks', route: taskRoute },
  { path: '/notifications', route: notificationRoute },
  { path: '/dashboard', route: dashboardRoute },
  { path: '/cnp', route: cnpRoute },
  { path: '/call-again', route: callAgainRoute },
  { path: '/verification', route: verificationRoute },
  { path: '/ready-to-shipment', route: readyToShipmentRoute },
  { path: '/shiprocket', route: shiprocketRoute },
  { path: '/attendance', route: attendanceRoute },
  { path: '/appointments', route: appointmentRoute },
  { path: '/search', route: searchRoute },
  { path: '/commission', route: commissionRoute },
  { path: '/interakt', route: interaktRoute },
  { path: '/shipmaxx', route: shipmaxxRoute },
  { path: '/integrations', route: integrationsRoute },
];
 
defaultRoutes.forEach((route) => {
  router.use(route.path, route.route);
});

export default router;

import express from 'express';
import auth from '../../middleware/auth.js';
import appointmentController from './appointment.controller.js';

const router = express.Router();

router
  .route('/')
  .post(auth('admin', 'manager', 'sales', 'doctor', 'staff', 'support'), appointmentController.createAppointment)
  .get(auth('admin', 'manager', 'sales', 'doctor', 'staff', 'support'), appointmentController.getAppointments);

router.get('/availability', auth('admin', 'manager', 'sales', 'doctor', 'staff', 'support'), appointmentController.getAvailability);
router.get('/booked-slots', auth('admin', 'manager', 'sales', 'doctor', 'staff', 'support'), appointmentController.getBookedSlots);

router
  .route('/:id')
  .get(auth('admin', 'manager', 'sales', 'doctor', 'staff', 'support'), appointmentController.getAppointment)
  .patch(auth('admin', 'manager', 'sales', 'doctor', 'staff', 'support'), appointmentController.updateAppointment)
  .delete(auth('admin', 'manager'), appointmentController.deleteAppointment);

router.post('/:id/field-notes', auth('admin', 'manager', 'sales', 'doctor', 'staff', 'support'), appointmentController.addFieldNote);

export default router;

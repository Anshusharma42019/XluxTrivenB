import express from 'express';
import auth from '../../middleware/auth.js';
import departmentFilter from '../../middleware/departmentFilter.js';
import appointmentController from './appointment.controller.js';

const router = express.Router();

router
  .route('/')
  .post(auth('admin', 'manager', 'sales', 'doctor', 'staff', 'support'), departmentFilter, appointmentController.createAppointment)
  .get(auth('admin', 'manager', 'sales', 'doctor', 'staff', 'support'), departmentFilter, appointmentController.getAppointments);

router.get('/availability', auth('admin', 'manager', 'sales', 'doctor', 'staff', 'support'), departmentFilter, appointmentController.getAvailability);
router.get('/booked-slots', auth('admin', 'manager', 'sales', 'doctor', 'staff', 'support'), departmentFilter, appointmentController.getBookedSlots);

router
  .route('/:id')
  .get(auth('admin', 'manager', 'sales', 'doctor', 'staff', 'support'), departmentFilter, appointmentController.getAppointment)
  .patch(auth('admin', 'manager', 'sales', 'doctor', 'staff', 'support'), departmentFilter, appointmentController.updateAppointment)
  .delete(auth('admin', 'manager'), appointmentController.deleteAppointment);

router.post('/:id/field-notes', auth('admin', 'manager', 'sales', 'doctor', 'staff', 'support'), departmentFilter, appointmentController.addFieldNote);

export default router;

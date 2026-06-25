import httpStatus from 'http-status';
import catchAsync from '../../utils/catchAsync.js';
import ApiResponse from '../../utils/ApiResponse.js';
import * as appointmentService from './appointment.service.js';

const createAppointment = catchAsync(async (req, res) => {
  const appt = await appointmentService.createAppointment(req.body, req.user._id);
  res.status(httpStatus.CREATED).json(new ApiResponse(httpStatus.CREATED, appt, 'Appointment created'));
});

const getAppointments = catchAsync(async (req, res) => {
  const result = await appointmentService.getAppointments(req.query);
  res.json(new ApiResponse(httpStatus.OK, result, 'Appointments fetched'));
});

const getAppointment = catchAsync(async (req, res) => {
  const appt = await appointmentService.getAppointmentById(req.params.id);
  res.json(new ApiResponse(httpStatus.OK, appt, 'Appointment fetched'));
});

const updateAppointment = catchAsync(async (req, res) => {
  const appt = await appointmentService.updateAppointment(req.params.id, req.body);
  res.json(new ApiResponse(httpStatus.OK, appt, 'Appointment updated'));
});

const deleteAppointment = catchAsync(async (req, res) => {
  await appointmentService.deleteAppointment(req.params.id);
  res.json(new ApiResponse(httpStatus.OK, null, 'Appointment deleted'));
});

const getAvailability = catchAsync(async (req, res) => {
  const { date, timeSlot } = req.query;
  if (!date || !timeSlot) return res.json(new ApiResponse(httpStatus.OK, [], 'No params'));
  const bookedDoctors = await appointmentService.getDoctorAvailability(date, timeSlot);
  res.json(new ApiResponse(httpStatus.OK, bookedDoctors, 'Availability fetched'));
});

const getBookedSlots = catchAsync(async (req, res) => {
  const { date, doctorName } = req.query;
  if (!date || !doctorName) return res.json(new ApiResponse(httpStatus.OK, [], 'No params'));
  const slots = await appointmentService.getDoctorBookedSlots(date, doctorName);
  res.json(new ApiResponse(httpStatus.OK, slots, 'Booked slots fetched'));
});

const addFieldNote = catchAsync(async (req, res) => {
  const { text } = req.body;
  const appt = await appointmentService.addFieldNote(req.params.id, text, req.user?.name || 'Staff');
  res.json(new ApiResponse(httpStatus.OK, appt, 'Note added'));
});

export default { createAppointment, getAppointments, getAppointment, updateAppointment, deleteAppointment, getAvailability, getBookedSlots, addFieldNote };

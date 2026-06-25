import Appointment from './appointment.model.js';
import ApiError from '../../utils/ApiError.js';
import httpStatus from 'http-status';

export const getDoctorAvailability = async (date, timeSlot) => {
  const start = new Date(date + 'T00:00:00.000Z');
  const end = new Date(date + 'T23:59:59.999Z');
  const [h, m] = timeSlot.split(':').map(Number);
  const slotMinutes = h * 60 + m;
  const dayAppts = await Appointment.find({
    isDeleted: false,
    appointmentDate: { $gte: start, $lte: end },
    status: { $nin: ['cancelled', 'no_show'] },
  }).select('doctorName timeSlot').lean();
  const booked = dayAppts
    .filter(a => {
      const [ah, am] = a.timeSlot.split(':').map(Number);
      return Math.abs((ah * 60 + am) - slotMinutes) < 10;
    })
    .map(a => a.doctorName);
  return [...new Set(booked)];
};

export const getDoctorBookedSlots = async (date, doctorName) => {
  const start = new Date(date + 'T00:00:00.000Z');
  const end = new Date(date + 'T23:59:59.999Z');
  const appts = await Appointment.find({
    isDeleted: false,
    doctorName,
    appointmentDate: { $gte: start, $lte: end },
    status: { $nin: ['cancelled', 'no_show'] },
  }).select('timeSlot').lean();
  return appts.map(a => a.timeSlot);
};

export const createAppointment = async (body, userId) => {
  const { doctorName, appointmentDate, timeSlot } = body;
  const dateStr = new Date(appointmentDate).toISOString().split('T')[0];
  const bookedDoctors = await getDoctorAvailability(dateStr, timeSlot);
  if (bookedDoctors.includes(doctorName)) {
    throw new ApiError(400, `Dr. ${doctorName} already has an appointment within 10 minutes of this time. Please choose a different time or doctor.`);
  }
  return Appointment.create({ ...body, createdBy: userId });
};

export const getAppointments = async (query) => {
  const { page = 1, limit = 20, search, dateFrom, dateTo, status, excludeStatus, doctorName } = query;
  const filter = { isDeleted: false };

  if (status) filter.status = status;
  if (excludeStatus) {
    const excluded = excludeStatus.split(',').map(s => s.trim());
    filter.status = { $nin: excluded };
  }
  if (doctorName) filter.doctorName = new RegExp(doctorName, 'i');
  if (dateFrom || dateTo) {
    filter.appointmentDate = {};
    if (dateFrom) filter.appointmentDate.$gte = new Date(dateFrom + 'T00:00:00.000Z');
    if (dateTo) filter.appointmentDate.$lte = new Date(dateTo + 'T23:59:59.999Z');
  }
  if (search) {
    const q = new RegExp(search, 'i');
    filter.$or = [{ patientName: q }, { phone: q }, { doctorName: q }];
  }

  const skip = (Number(page) - 1) * Number(limit);
  const [appointments, total] = await Promise.all([
    Appointment.find(filter)
      .sort({ appointmentDate: 1 })
      .skip(skip)
      .limit(Number(limit))
      .populate('createdBy', 'name')
      .lean(),
    Appointment.countDocuments(filter),
  ]);

  return { appointments, total, totalPages: Math.ceil(total / Number(limit)) };
};

export const getAppointmentById = async (id) => {
  const appt = await Appointment.findOne({ _id: id, isDeleted: false })
    .populate('createdBy', 'name')
    .lean();
  if (!appt) throw new ApiError(httpStatus.NOT_FOUND, 'Appointment not found');
  return appt;
};

export const updateAppointment = async (id, body) => {
  const appt = await Appointment.findOneAndUpdate(
    { _id: id, isDeleted: false },
    body,
    { new: true, runValidators: true }
  ).lean();
  if (!appt) throw new ApiError(httpStatus.NOT_FOUND, 'Appointment not found');
  return appt;
};

export const deleteAppointment = async (id) => {
  const appt = await Appointment.findOneAndUpdate(
    { _id: id, isDeleted: false },
    { isDeleted: true },
    { new: true }
  );
  if (!appt) throw new ApiError(httpStatus.NOT_FOUND, 'Appointment not found');
};

export const addFieldNote = async (id, text, addedBy) => {
  const appt = await Appointment.findOneAndUpdate(
    { _id: id, isDeleted: false },
    { $push: { fieldNotes: { text, addedBy, addedAt: new Date() } } },
    { new: true, runValidators: false }
  ).lean();
  if (!appt) throw new ApiError(httpStatus.NOT_FOUND, 'Appointment not found');
  return appt;
};

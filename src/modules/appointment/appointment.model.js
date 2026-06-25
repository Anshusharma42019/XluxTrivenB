import mongoose from 'mongoose';

const appointmentSchema = new mongoose.Schema(
  {
    patientName: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true },
    doctorName: { type: String, required: true, trim: true },
    appointmentDate: { type: Date, required: true },
    timeSlot: { type: String, required: true },
    type: {
      type: String,
      enum: ['consultation', 'follow_up', 'panchakarma', 'ayurveda', 'other'],
      default: 'consultation',
    },
    status: {
      type: String,
      enum: ['scheduled', 'confirmed', 'completed', 'cancelled', 'no_show'],
      default: 'scheduled',
    },
    patientType: {
      type: String,
      enum: ['new', 'old'],
      default: 'new',
    },
    problem: { type: String, trim: true },
    address: { type: String, trim: true },
    houseNo: { type: String, trim: true },
    cityVillage: { type: String, trim: true },
    postOffice: { type: String, trim: true },
    landmark: { type: String, trim: true },
    district: { type: String, trim: true },
    state: { type: String, trim: true },
    pincode: { type: String, trim: true },
    medicineDeliveryDate: { type: Date },
    notes: { type: String, trim: true },
    fieldNotes: [{
      text: { type: String, trim: true },
      addedBy: { type: String },
      addedAt: { type: Date, default: Date.now },
    }],
    lead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

appointmentSchema.index({ appointmentDate: 1, status: 1 });
appointmentSchema.index({ phone: 1 });

export const Appointment = mongoose.model('Appointment', appointmentSchema);
export default Appointment;

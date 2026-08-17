import mongoose from 'mongoose';

const invoiceLineItemSchema = new mongoose.Schema({
  sno: Number,
  description: String,
  hsn: String,
  qty: Number,
  rate: Number,
  amount: Number,
  gstRate: String,
  cgst: Number,
  sgst: Number,
  igst: Number,
  total: Number,
  isDoctor: { type: Boolean, default: false }
}, { _id: false });

const invoiceHistorySchema = new mongoose.Schema(
  {
    billNumber: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    orderId: {
      type: String,
      required: true,
      index: true
    },
    invoiceDate: {
      type: Date,
      required: true
    },
    customerName: String,
    customerPhone: String,
    customerAddress: String,
    customerState: String,
    customerCity: String,
    customerPincode: String,
    doctorFee: {
      type: Number,
      default: 0
    },
    taxMode: {
      type: String,
      enum: ['intra', 'inter'],
      required: true
    },
    lineItems: [invoiceLineItemSchema],
    totalTaxableValue: Number,
    totalCGST: Number,
    totalSGST: Number,
    totalIGST: Number,
    totalGST: Number,
    grandTotal: Number,
    generatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true
    }
  },
  {
    timestamps: true
  }
);

invoiceHistorySchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

export const InvoiceHistory = mongoose.model('InvoiceHistory', invoiceHistorySchema);
export default InvoiceHistory;

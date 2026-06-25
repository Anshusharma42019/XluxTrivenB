import mongoose from 'mongoose';

const walletTransactionSchema = new mongoose.Schema(
  {
    order_id: { type: String, trim: true, default: '' },
    billing_customer_name: { type: String, trim: true, default: '' },
    billing_phone: { type: String, trim: true, default: '' },
    awb_code: { type: String, trim: true, default: '' },
    courier_name: { type: String, trim: true, default: '' },
    payment_method: { type: String, trim: true, default: '' },
    type: { type: String, enum: ['cod', 'prepaid'], default: 'prepaid' },
    amount: { type: Number, default: 0 },
    status: { type: String, trim: true, default: '' },
    note: { type: String, trim: true, default: '' },
    transaction_date: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

walletTransactionSchema.index({ transaction_date: -1 });
walletTransactionSchema.index({ order_id: 1 }, { unique: true, sparse: true });

export const WalletTransaction = mongoose.model('WalletTransaction', walletTransactionSchema);
export default WalletTransaction;

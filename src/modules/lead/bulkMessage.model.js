import mongoose from 'mongoose';

const bulkMessageBatchSchema = new mongoose.Schema(
  {
    section: { type: String, required: true },
    template: { type: String, required: true },
    sent_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    total: { type: Number, default: 0 },
    sent_count: { type: Number, default: 0 },
    failed_count: { type: Number, default: 0 },
    excluded_count: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['queued', 'processing', 'completed', 'failed'],
      default: 'queued',
    },
    completed_at: { type: Date },
  },
  { timestamps: true }
);

export const BulkMessageBatch = mongoose.model('BulkMessageBatch', bulkMessageBatchSchema);

const bulkMessageRecipientSchema = new mongoose.Schema(
  {
    batch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'BulkMessageBatch', required: true },
    lead_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', required: true },
    status: {
      type: String,
      enum: ['sent', 'failed', 'excluded', 'delivered', 'read'],
      default: 'sent',
    },
    error_reason: { type: String },
    sent_at: { type: Date },
  },
  { timestamps: true }
);

// Indexes for fast lookup
bulkMessageRecipientSchema.index({ batch_id: 1, status: 1 });
bulkMessageRecipientSchema.index({ lead_id: 1 });

export const BulkMessageRecipient = mongoose.model('BulkMessageRecipient', bulkMessageRecipientSchema);

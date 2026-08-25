import mongoose from 'mongoose';
import crypto from 'crypto';

/**
 * OrderChain — immutable, hash-linked record of every order submitted for a customer.
 *
 * Chain integrity:
 *   self_hash = SHA256( lead_id + chain_seq + submitter_id + order_id + order_type + prev_hash )
 *   prev_hash of entry N = self_hash of entry N-1
 *   Entry 1 (first order): prev_hash = '0000...0' (genesis)
 *
 * ⚠️  IMMUTABILITY CONTRACT
 *   • submitter_id is frozen at insert — no route or service modifies it.
 *   • No update or delete routes exist for this collection.
 *   • DB-level role grants only { insert, find } (see implementation_plan.md).
 */
const orderChainSchema = new mongoose.Schema(
  {
    // ── Customer linkage ──────────────────────────────────────────────────────
    lead_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', required: true, index: true },

    // ── Order reference (dynamic model — supports Shiprocket and Shipmaxx) ────
    order_id:    { type: mongoose.Schema.Types.ObjectId, refPath: 'order_model', default: null },
    order_model: { type: String, enum: ['ShiprocketOrder', 'ShipmaxxOrder'], default: 'ShiprocketOrder' },

    // ── Strict chronological position in this customer's chain ────────────────
    // Starts at 1 for the first order, increments by 1 for every subsequent order.
    chain_seq: { type: Number, required: true, min: 1 },

    // ── Submitter ID — LOCKED at the moment the order enters verification ─────
    // For first orders: the salesperson who created/submitted the order.
    // For repeat orders: whoever submitted the repeat order to verification.
    submitter_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    // ── Order classification ──────────────────────────────────────────────────
    order_type: { type: String, enum: ['first', 'repeat'], required: true },

    // ── Rule version snapshot ─────────────────────────────────────────────────
    // The version string of the active commission rule at the time of this entry.
    // Historical entries always carry the version they were created under.
    rule_version: { type: String, default: 'v1.0' },

    // ── Hash-chain integrity fields ───────────────────────────────────────────
    // Hash of the previous entry's canonical fields (genesis entry uses '0'.repeat(64))
    prev_hash: { type: String, required: true },
    // Hash of THIS entry's canonical fields (computed and stored at insert time)
    self_hash: { type: String, required: true },
  },
  {
    timestamps: true,
  }
);

// ── Indexes ───────────────────────────────────────────────────────────────────
orderChainSchema.index({ lead_id: 1, chain_seq: 1 }, { unique: true });
orderChainSchema.index({ submitter_id: 1, createdAt: -1 });
orderChainSchema.index({ order_id: 1 });

// ── Immutability guard ────────────────────────────────────────────────────────
const IMMUTABLE_ERROR = 'OrderChain is append-only. Records cannot be modified after creation.';
orderChainSchema.pre(['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne'], function () {
  throw new Error(IMMUTABLE_ERROR);
});
orderChainSchema.pre(['deleteOne', 'deleteMany', 'findOneAndDelete'], function () {
  throw new Error(IMMUTABLE_ERROR);
});

// ── Static: compute the canonical hash for a chain entry ─────────────────────
orderChainSchema.statics.computeHash = function ({ lead_id, chain_seq, submitter_id, order_id, order_type, prev_hash }) {
  const canonical = [
    String(lead_id),
    String(chain_seq),
    String(submitter_id),
    String(order_id || 'null'),
    order_type,
    prev_hash,
  ].join('|');
  return crypto.createHash('sha256').update(canonical).digest('hex');
};

// ── Static: Genesis hash (used as prev_hash for the very first chain entry) ──
orderChainSchema.statics.GENESIS_HASH = '0'.repeat(64);

const OrderChain = mongoose.model('OrderChain', orderChainSchema);
export default OrderChain;

import mongoose from 'mongoose';

/**
 * CommissionRecord — immutable, append-only commission ledger.
 *
 * Design principles:
 *  1. NEVER update or delete a row after creation.
 *  2. Corrections = a new row with entry_type:'reversal' pointing to the original via reversal_of.
 *  3. Net balance for a staff member = SUM( amount WHERE entry_type='credit' )
 *                                     + SUM( amount WHERE entry_type='reversal' )  [negative values]
 *  4. Every row carries the rule_version and a full rule_snapshot so historical
 *     views always show the business rule that was active when the commission was earned.
 *
 * ⚠️  IMMUTABILITY CONTRACT
 *   • No update/delete routes exist for this collection.
 *   • DB-level role grants only { insert, find } (see implementation_plan.md).
 *   • Payment confirmation is tracked via entry_type:'payment_confirmation' insert,
 *     OR via the status field mutation (acceptable for payment status per Q4 decision).
 */
const commissionRecordSchema = new mongoose.Schema(
  {
    // ── Chain linkage ─────────────────────────────────────────────────────────
    chain_entry_id: { type: mongoose.Schema.Types.ObjectId, ref: 'OrderChain', required: true, index: true },

    // ── Order reference ───────────────────────────────────────────────────────
    // order_id is optional at verification-sync time (order not created yet).
    // It is set once the physical order is placed in Shiprocket/Shipmaxx.
    order_id:    { type: mongoose.Schema.Types.ObjectId, refPath: 'order_model', default: null, index: true, sparse: true },
    order_model: { type: String, enum: ['ShiprocketOrder', 'ShipmaxxOrder'], default: 'ShiprocketOrder' },

    // ── Customer ──────────────────────────────────────────────────────────────
    lead_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', index: true },

    // ── Beneficiary ──────────────────────────────────────────────────────────
    staff_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    // 'original' = the salesperson from the FIRST order (gets original_staff_commission)
    // 'reorder'  = whoever submitted the REPEAT order to verification
    commission_role: { type: String, enum: ['original', 'reorder'], required: true },

    // ── Financials ────────────────────────────────────────────────────────────
    commission_amount: { type: Number, required: true }, // positive for credit, negative for reversal
    commission_type:   { type: String, enum: ['flat', 'percent'], default: 'flat' },
    order_sub_total:   { type: Number, default: 0 },

    // ── Rule versioning (immutable snapshots) ─────────────────────────────────
    // The version string active when this row was created (e.g. 'v1.0')
    rule_version: { type: String, default: 'v1.0' },
    // Full copy of the FollowupCommissionSettings doc used to calculate this amount.
    // Allows historical display of the exact rule that applied, even if settings change later.
    rule_snapshot: { type: mongoose.Schema.Types.Mixed, default: {} },

    // ── Entry type ────────────────────────────────────────────────────────────
    entry_type: {
      type: String,
      enum: ['credit', 'reversal'],
      default: 'credit',
    },
    // If this row is a reversal, points to the original CommissionRecord being corrected.
    reversal_of: { type: mongoose.Schema.Types.ObjectId, ref: 'CommissionRecord', default: null },

    // ── Payment state ─────────────────────────────────────────────────────────
    // Status may be mutated for payment tracking (acceptable per plan Q4).
    // Only 'pending' → 'paid' transition is allowed; no other mutations.
    status:  { type: String, enum: ['pending', 'paid'], default: 'pending', index: true },
    paid_at: { type: Date, default: null },
    paid_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    // ── Time bucketing for reports ────────────────────────────────────────────
    month: { type: Number }, // 0-indexed JS month
    year:  { type: Number },

    // ── Notes ─────────────────────────────────────────────────────────────────
    note: { type: String, default: '' },
  },
  {
    timestamps: true,
  }
);

// ── Compound indexes ────────────────────────────────────────────────────────
commissionRecordSchema.index({ staff_id: 1, month: 1, year: 1 });
// Idempotency: one credit/reversal row per chain entry + role combination.
// order_id is NOT used here because it can be null at sync time.
commissionRecordSchema.index({ chain_entry_id: 1, commission_role: 1, entry_type: 1 }, { unique: true });
commissionRecordSchema.index({ order_id: 1, commission_role: 1 }, { sparse: true }); // for order-level lookups
commissionRecordSchema.index({ rule_version: 1 });

// ── Immutability guard ────────────────────────────────────────────────────────
// Block all structural mutations via Mongoose query middleware.
// Exception: status (pending→paid) is allowed via direct collection method on admin paths.
// Exception: updatedAt/createdAt are Mongoose timestamps auto-injected — not business mutations.
const ALLOWED_UPDATE_KEYS = new Set(['status', 'paid_at', 'paid_by', 'updatedAt', 'createdAt']);

commissionRecordSchema.pre(['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne'], function () {
  const update = this.getUpdate?.() || {};

  // Allow pure upsert-insert operations ($setOnInsert only — no $set, no other mutation).
  // When MongoDB performs an upsert INSERT (not an update of an existing doc), the
  // only key present is $setOnInsert, which is safe and not a mutation of existing data.
  const hasSetOnInsertOnly = update.$setOnInsert && !update.$set && !update.$unset && !update.$push;
  if (hasSetOnInsertOnly) return;

  const setKeys = Object.keys(update.$set || update);
  const forbidden = setKeys.filter(k => !ALLOWED_UPDATE_KEYS.has(k));
  if (forbidden.length > 0) {
    throw new Error(
      `CommissionRecord is append-only. Cannot update fields: ${forbidden.join(', ')}. Create a reversal row instead.`
    );
  }
});

commissionRecordSchema.pre(['deleteOne', 'deleteMany', 'findOneAndDelete'], function () {
  throw new Error('CommissionRecord is append-only. Records cannot be deleted.');
});

const CommissionRecord = mongoose.model('CommissionRecord', commissionRecordSchema);
export default CommissionRecord;

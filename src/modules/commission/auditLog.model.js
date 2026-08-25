import mongoose from 'mongoose';

/**
 * AuditLog — append-only ledger of every commission-workflow action.
 *
 * ⚠️  IMMUTABILITY CONTRACT
 *   • No route or service in this codebase calls .update() or .delete() on this collection.
 *   • At the DB layer, the application user should be granted only { insert, find } on
 *     this collection (see implementation_plan.md → Immutability Enforcement).
 *   • Corrections are recorded as NEW entries with action = 'correction_note'.
 */
const auditLogSchema = new mongoose.Schema(
  {
    // ── Who performed the action ──────────────────────────────────────────────
    actor_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    // ── What happened ─────────────────────────────────────────────────────────
    action: {
      type: String,
      required: true,
      enum: [
        'order_submitted',          // first or repeat order entered verification
        'submitter_locked',         // submitter_id frozen onto OrderChain entry
        'commission_split_calculated', // two CommissionRecord rows created for a repeat order
        'commission_first_order_credit',  // single CommissionRecord row created for a first order
        'commission_paid',          // payment status recorded
        'commission_reversed',      // reversal row inserted
        'settings_updated',         // FollowupCommissionSettings changed
        'chain_entry_created',      // OrderChain row inserted
        'correction_note',          // arbitrary admin correction note
      ],
    },

    // ── Which entity was affected ─────────────────────────────────────────────
    entity_type: {
      type: String,
      required: true,
      enum: ['OrderChain', 'CommissionRecord', 'Verification', 'FollowupCommissionSettings'],
    },
    entity_id: { type: mongoose.Schema.Types.ObjectId, required: true },

    // ── Rule version active when this action occurred ─────────────────────────
    rule_version: { type: String, default: 'v1.0' },

    // ── Snapshots ─────────────────────────────────────────────────────────────
    before_state: { type: mongoose.Schema.Types.Mixed, default: null },
    after_state:  { type: mongoose.Schema.Types.Mixed, default: null },

    // ── Extra context ─────────────────────────────────────────────────────────
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },

    // Optional IP of the actor for security tracing
    ip: { type: String, default: null },
  },
  {
    // createdAt is the authoritative timestamp of the action — updatedAt is meaningless
    timestamps: { createdAt: true, updatedAt: false },
  }
);

// ── Indexes for efficient audit queries ───────────────────────────────────────
auditLogSchema.index({ actor_id: 1, createdAt: -1 });
auditLogSchema.index({ entity_type: 1, entity_id: 1, createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });
auditLogSchema.index({ rule_version: 1 });

// ── Guard: prevent accidental mutations via Mongoose middleware ───────────────
const IMMUTABLE_ERROR = 'AuditLog is append-only. Use a new entry to record corrections.';
auditLogSchema.pre(['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne'], function () {
  throw new Error(IMMUTABLE_ERROR);
});
auditLogSchema.pre(['deleteOne', 'deleteMany', 'findOneAndDelete'], function () {
  throw new Error(IMMUTABLE_ERROR);
});

const AuditLog = mongoose.model('AuditLog', auditLogSchema);
export default AuditLog;

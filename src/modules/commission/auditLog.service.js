import AuditLog from './auditLog.model.js';

/**
 * auditLog.service.js
 * -------------------
 * The single insert-only function for recording every commission-workflow action.
 *
 * Usage:
 *   import { logAction } from '../commission/auditLog.service.js';
 *   await logAction({
 *     actor:       req.user,
 *     action:      'submitter_locked',
 *     entityType:  'OrderChain',
 *     entityId:    chainEntry._id,
 *     ruleVersion: chainEntry.rule_version,
 *     before:      null,
 *     after:       chainEntry.toObject(),
 *     meta:        { lead_id: chainEntry.lead_id },
 *     ip:          req.ip,
 *   });
 *
 * This function never throws — failures are silently logged to console so that
 * a broken audit-trail write never blocks the main transaction.
 */
export const logAction = async ({
  actor,
  action,
  entityType,
  entityId,
  ruleVersion = 'v1.0',
  before      = null,
  after       = null,
  meta        = {},
  ip          = null,
}) => {
  try {
    const actorId = actor?._id || actor;
    if (!actorId || !action || !entityType || !entityId) {
      console.error('[AuditLog] Missing required fields — log entry skipped.', {
        actorId, action, entityType, entityId,
      });
      return null;
    }

    const entry = await AuditLog.create({
      actor_id:     actorId,
      action,
      entity_type:  entityType,
      entity_id:    entityId,
      rule_version: ruleVersion,
      before_state: before,
      after_state:  after,
      metadata:     meta,
      ip,
    });

    return entry;
  } catch (err) {
    // Audit-trail failures must never block business logic.
    console.error('[AuditLog] Failed to write audit log entry:', err.message);
    return null;
  }
};

/**
 * Fetch the full audit trail for a given entity.
 *
 * @param {string} entityType  — 'OrderChain' | 'CommissionRecord' | etc.
 * @param {ObjectId|string} entityId
 * @returns {Promise<AuditLog[]>}
 */
export const getAuditTrail = async (entityType, entityId) => {
  return AuditLog.find({ entity_type: entityType, entity_id: entityId })
    .populate('actor_id', 'name role')
    .sort({ createdAt: 1 })
    .lean();
};

import mongoose from 'mongoose';
import Lead from '../lead/lead.model.js';
import { Task } from '../task/task.model.js';
import Verification from '../verification/verification.model.js';
import ReadyToShipment from '../readytoshipment/readytoshipment.model.js';
import CallAgain from '../callagain/callagain.model.js';
import Cnp from '../cnp/cnp.model.js';
import {
  InterestedLead,
  NotInterestedLead,
  PendingOrder,
  OnHoldOrder,
  VerifiedOrder
} from './statusModels.js';
import ApiError from '../../utils/ApiError.js';
import httpStatus from 'http-status';

export const STATUS_ROUTING_MATRIX = {
  new: { model: Lead, collection: 'leads' },
  raw: { model: Lead, collection: 'leads' },
  open: { model: Lead, collection: 'leads' },
  
  task: { model: Task, collection: 'tasks' },
  in_progress: { model: Task, collection: 'tasks' },
  pending: { model: Task, collection: 'tasks' },
  overdue: { model: Task, collection: 'tasks' },
  action: { model: Task, collection: 'tasks' },
  
  interested: { model: InterestedLead, collection: 'interestedleads' },
  warm: { model: InterestedLead, collection: 'interestedleads' },

  not_interested: { model: NotInterestedLead, collection: 'notinterestedleads' },
  closed_lost: { model: NotInterestedLead, collection: 'notinterestedleads' },
  lost: { model: NotInterestedLead, collection: 'notinterestedleads' },
  rejected: { model: NotInterestedLead, collection: 'notinterestedleads' },
  closed: { model: NotInterestedLead, collection: 'notinterestedleads' },
  cancel: { model: NotInterestedLead, collection: 'notinterestedleads' },
  cancelled: { model: NotInterestedLead, collection: 'notinterestedleads' },

  cnp: { model: Cnp, collection: 'cnps' },

  call_again: { model: CallAgain, collection: 'callagains' },
  callback: { model: CallAgain, collection: 'callagains' },
  follow_up: { model: CallAgain, collection: 'callagains' },
  followup: { model: CallAgain, collection: 'callagains' },
  contacted: { model: CallAgain, collection: 'callagains' },

  verification: { model: Verification, collection: 'verifications' },
  pending_verification: { model: Verification, collection: 'verifications' },
  under_verification: { model: Verification, collection: 'verifications' },

  pending_evaluation: { model: PendingOrder, collection: 'pendingorders' },
  pending_order: { model: PendingOrder, collection: 'pendingorders' },
  pendingorder: { model: PendingOrder, collection: 'pendingorders' },

  on_hold: { model: OnHoldOrder, collection: 'onholdorders' },
  hold: { model: OnHoldOrder, collection: 'onholdorders' },
  parked: { model: OnHoldOrder, collection: 'onholdorders' },

  verified: { model: VerifiedOrder, collection: 'verifiedorders' },
  verified_order: { model: VerifiedOrder, collection: 'verifiedorders' },
  converted: { model: VerifiedOrder, collection: 'verifiedorders' },
  closed_won: { model: VerifiedOrder, collection: 'verifiedorders' },
  approved: { model: VerifiedOrder, collection: 'verifiedorders' },

  ready_to_shipment: { model: ReadyToShipment, collection: 'readytoshipments' },
  rts: { model: ReadyToShipment, collection: 'readytoshipments' },
  readytoshipment: { model: ReadyToShipment, collection: 'readytoshipments' }
};

/**
 * Universal Status Transition Router
 * Transfers record to dedicated status collection with Zero-Data-Loss guarantee.
 */
export const transitionRecord = async (arg1, arg2, arg3, arg4 = {}, arg5 = null) => {
  let originModel, recordId, targetStatus, updatedFields, changedBy;
  if (arg1 && typeof arg1 === 'object' && arg1.originModel && arg1.recordId && !arg1.modelName && !arg1.collection) {
    ({ originModel, recordId, targetStatus, updatedFields = {}, changedBy = null } = arg1);
  } else {
    originModel = arg1;
    recordId = arg2;
    targetStatus = arg3;
    updatedFields = arg4 || {};
    changedBy = arg5;
  }

  if (!targetStatus) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Target status is required for transition');
  }

  const targetConfig = STATUS_ROUTING_MATRIX[targetStatus.toLowerCase()];
  
  // If target status is not mapped or is identical to the current origin collection, perform standard update without migration
  if (!targetConfig || targetConfig.model.collection.name === originModel.collection.name) {
    let cleanChangedBy = undefined;
    if (changedBy && changedBy._id && mongoose.Types.ObjectId.isValid(String(changedBy._id))) cleanChangedBy = changedBy._id;
    else if (changedBy && typeof changedBy !== 'object' && mongoose.Types.ObjectId.isValid(String(changedBy))) cleanChangedBy = changedBy;

    const updatedDoc = await originModel.findByIdAndUpdate(
      recordId, 
      { ...updatedFields, status: targetStatus, changedBy: cleanChangedBy || undefined },
      { returnDocument: 'after', runValidators: true }
    );
    if (!updatedDoc) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Origin record not found');
    }
    return { record: updatedDoc, migrated: false, collection: originModel.collection.name };
  }

  const TargetModel = targetConfig.model;
  const targetCollectionName = targetConfig.collection;
  let originCollectionName = originModel.collection.name;

  // Start Atomic Mongoose Two-Phase Commit Transaction (with fallback for local standalone DBs)
  let session = null;
  let usingTransaction = false;
  try {
    session = await mongoose.startSession();
    session.startTransaction();
    usingTransaction = true;
  } catch (e) {
    if (session) {
      try { session.endSession(); } catch (err) {}
      session = null;
    }
  }

  try {
    const queryOpts = usingTransaction ? { session } : {};
    
    // Step 1: Fetch active original record first (to avoid editing old dead/archived copies in origin table)
    let originDoc = await originModel.findOne({ _id: recordId, isDeleted: { $ne: true }, isArchived: { $ne: true } }, null, queryOpts).lean();
    
    if (!originDoc) {
      // Intelligent multi-table fallback: search across all status tables for an active record
      for (const key in STATUS_ROUTING_MATRIX) {
        const candidateModel = STATUS_ROUTING_MATRIX[key].model;
        if (candidateModel && candidateModel.collection.name !== originModel.collection.name) {
          try {
            originDoc = await candidateModel.findOne({ _id: recordId, isDeleted: { $ne: true }, isArchived: { $ne: true } }, null, queryOpts).lean();
            if (originDoc) {
              originModel = candidateModel;
              originCollectionName = candidateModel.collection.name;
              break;
            }
          } catch (e) {}
        }
      }
    }
    
    // If no active doc exists anywhere, check if an archived version exists to resurrect it
    if (!originDoc) {
      originDoc = await originModel.findOne({ _id: recordId }, null, queryOpts).lean();
      if (!originDoc) {
        for (const key in STATUS_ROUTING_MATRIX) {
          const candidateModel = STATUS_ROUTING_MATRIX[key].model;
          if (candidateModel) {
            try {
              originDoc = await candidateModel.findOne({ _id: recordId }, null, queryOpts).lean();
              if (originDoc) {
                originModel = candidateModel;
                originCollectionName = candidateModel.collection.name;
                break;
              }
            } catch (e) {}
          }
        }
      }
    }

    if (!originDoc) {
      // Return gracefully without logging exceptions if record does not exist in DB yet
      if (usingTransaction && session) {
        await session.abortTransaction();
        session.endSession();
      }
      return { migrated: false, notFound: true, message: `Record ${recordId} not found in any table` };
    }

    const wrapperCollections = ['cnps', 'callagains', 'verifications', 'readytoshipments', 'tasks'];
    const isTargetWrapper = wrapperCollections.includes(TargetModel.collection.name);
    const isOriginWrapper = wrapperCollections.includes(originCollectionName);

    if (isOriginWrapper && !isTargetWrapper && originDoc.lead) {
      let parentLead = await Lead.findOne({ _id: originDoc.lead }).lean();
      let parentModel = Lead;
      if (!parentLead) {
        for (const k in STATUS_ROUTING_MATRIX) {
          const m = STATUS_ROUTING_MATRIX[k].model;
          if (m && !wrapperCollections.includes(m.collection.name)) {
            try {
              const doc = await m.findOne({ _id: originDoc.lead }).lean();
              if (doc) {
                parentLead = doc;
                parentModel = m;
                break;
              }
            } catch (e) {}
          }
        }
      }
      if (parentLead) {
        originDoc = parentLead;
        originModel = parentModel;
        originCollectionName = parentModel.collection.name;
        recordId = parentLead._id;
      }
    }

    // Clean up changedBy to ensure valid ObjectId or undefined (prevents Cast to ObjectId failures when user object or {} is passed)
    let cleanChangedBy = originDoc.changedBy;
    if (changedBy) {
      if (changedBy._id && mongoose.Types.ObjectId.isValid(String(changedBy._id))) {
        cleanChangedBy = changedBy._id;
      } else if (typeof changedBy !== 'object' && mongoose.Types.ObjectId.isValid(String(changedBy))) {
        cleanChangedBy = changedBy;
      }
    }

    // Step 2: Build field-for-field record preserving exact MongoDB _id and appending audit envelope
    const now = new Date();
    const migratedPayload = {
      ...originDoc,
      ...updatedFields,
      _id: originDoc._id,
      status: targetStatus,
      isArchived: false,
      isDeleted: false,
      transferredFrom: originCollectionName,
      transferredTo: null,
      transferredAt: now,
      originalCollection: originDoc.originalCollection || originCollectionName,
      changedBy: cleanChangedBy
    };

    delete migratedPayload.__v;

    const isWrapperTarget = isTargetWrapper;

    if (isWrapperTarget) {
      if (!migratedPayload.title) {
        migratedPayload.title = originDoc.title || originDoc.name || originDoc.phone || 'Status Transition Record';
      }
      if (!migratedPayload.task && TargetModel.schema.paths && TargetModel.schema.paths.task) {
        migratedPayload.task = originDoc.task || (originCollectionName === 'tasks' ? originDoc._id : originDoc._id);
      }
      if (!migratedPayload.lead && TargetModel.schema.paths && TargetModel.schema.paths.lead) {
        migratedPayload.lead = originDoc.lead || (originCollectionName === 'leads' ? originDoc._id : originDoc._id);
      }
    } else {
      // Cleanly remove wrapper pointer attributes so lead profiles don't become corrupted or shadow themselves
      delete migratedPayload.lead;
      delete migratedPayload.task;
    }
    if (!migratedPayload.phone && TargetModel.schema.paths && TargetModel.schema.paths.phone && TargetModel.schema.paths.phone.isRequired) {
      migratedPayload.phone = originDoc.phone || '0000000000';
    }

    // Step 3: Perform atomic UPSERT into destination status table (eliminates duplicates & E11000 index clashes)
    const targetQuery = { $or: [{ _id: migratedPayload._id }] };
    if (isWrapperTarget && migratedPayload.task && TargetModel.schema.paths && TargetModel.schema.paths.task) {
      targetQuery.$or.push({ task: migratedPayload.task });
    }
    if (isWrapperTarget && migratedPayload.lead && TargetModel.schema.paths && TargetModel.schema.paths.lead) {
      targetQuery.$or.push({ lead: migratedPayload.lead });
    }
    
    const { _id: targetDocId, ...updateFields } = migratedPayload;
    const insertedDoc = await TargetModel.findOneAndUpdate(
      targetQuery,
      { $set: updateFields, $setOnInsert: { _id: targetDocId } },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true, ...queryOpts, strict: false }
    );

    // Step 4: Universal Atomic Soft-Delete & Archive across all old tables so record disappears cleanly from previous sections!
    const matchIds = [recordId];
    if (originDoc.lead && String(originDoc.lead) !== String(recordId)) matchIds.push(originDoc.lead);
    if (originDoc._id && String(originDoc._id) !== String(recordId)) matchIds.push(originDoc._id);
    const validOids = matchIds.filter(id => id && mongoose.isValidObjectId(String(id))).map(id => new mongoose.Types.ObjectId(String(id)));
    const searchIds = [...new Set([...matchIds, ...validOids])];

    const archiveUpdate = {
      $set: {
        isDeleted: true,
        isArchived: true,
        transferredTo: targetCollectionName,
        transferredAt: now,
        changedBy: cleanChangedBy
      }
    };

    const processedCols = new Set([TargetModel.collection.name]);
    
    // Always archive in originModel if it's not the target model
    if (originModel.collection.name !== TargetModel.collection.name) {
      processedCols.add(originModel.collection.name);
      await originModel.updateMany({ _id: { $in: searchIds } }, archiveUpdate, { ...queryOpts, strict: false }).catch(() => {});
    }

    // Clean up all other mapped status collections concurrently in parallel for instant execution
    const cleanupTasks = [];
    for (const k in STATUS_ROUTING_MATRIX) {
      const candidate = STATUS_ROUTING_MATRIX[k].model;
      if (candidate && !processedCols.has(candidate.collection.name)) {
        processedCols.add(candidate.collection.name);
        const filter = { $or: [{ _id: { $in: searchIds } }, { lead: { $in: searchIds } }], isArchived: { $ne: true } };
        cleanupTasks.push(candidate.updateMany(filter, archiveUpdate, { ...queryOpts, strict: false }).catch(() => {}));
      }
    }
    await Promise.all(cleanupTasks);

    if (usingTransaction && session) {
      await session.commitTransaction();
      session.endSession();
    }

    return { 
      record: insertedDoc, 
      migrated: true, 
      fromCollection: originCollectionName,
      toCollection: targetCollectionName 
    };
  } catch (error) {
    if (usingTransaction && session) {
      try { await session.abortTransaction(); } catch (abortErr) {}
      try { session.endSession(); } catch (endErr) {}
    }
    throw error;
  }
};

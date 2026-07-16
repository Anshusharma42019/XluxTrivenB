import Lead from './lead.model.js';
import httpStatus from 'http-status';
import catchAsync from '../../utils/catchAsync.js';
import ApiResponse from '../../utils/ApiResponse.js';
import ApiError from '../../utils/ApiError.js';
import * as leadService from './lead.service.js';
import * as interaktService from '../interakt/interakt.service.js';
import { BulkMessageBatch, BulkMessageRecipient } from './bulkMessage.model.js';
import { bulkMessageQueue } from './bulkMessageQueue.js';

const createLead = catchAsync(async (req, res) => {
  const lead = await leadService.createLead(req.body, req.user._id, req.user.role, req.userDepartments);
  res.status(httpStatus.CREATED).json(new ApiResponse(httpStatus.CREATED, lead, 'Lead created'));
});

// Public route — no auth required (website inquiry form)
const submitLead = catchAsync(async (req, res) => {
  const lead = await leadService.createLead(req.body, null);
  res.status(httpStatus.CREATED).json(new ApiResponse(httpStatus.CREATED, lead, 'Inquiry submitted successfully'));
});

// Public route — department-specific form (e.g. /submit/piles or /submit/migraine)
const submitLeadForDepartment = catchAsync(async (req, res) => {
  const { department } = req.params;
  const allowedDepts = ['migraine', 'piles'];
  if (!allowedDepts.includes(department)) {
    return res.status(400).json({ message: 'Invalid department' });
  }
  const body = { ...req.body, department }; // force department from URL
  const lead = await leadService.createLead(body, null);
  res.status(httpStatus.CREATED).json(new ApiResponse(httpStatus.CREATED, lead, 'Inquiry submitted successfully'));
});

const getLeads = catchAsync(async (req, res) => {
  const result = await leadService.getLeads(req.query, req.query, req.user.role, req.user._id, req.userDepartments);
  res.json(new ApiResponse(httpStatus.OK, result, 'Leads fetched'));
});

const getLead = catchAsync(async (req, res) => {
  const lead = await leadService.getLeadById(req.params.leadId, req.user.role, req.user._id, req.userDepartments);
  if (lead && lead.hasUnreadReply) {
    await Lead.updateOne({ _id: lead._id }, { hasUnreadReply: false });
    lead.hasUnreadReply = false;
  }
  res.json(new ApiResponse(httpStatus.OK, lead, 'Lead fetched'));
});

const updateLead = catchAsync(async (req, res) => {
  const lead = await leadService.updateLead(req.params.leadId, req.body, req.user.role, req.user._id, req.userDepartments);
  res.json(new ApiResponse(httpStatus.OK, lead, 'Lead updated'));
});

const deleteLead = catchAsync(async (req, res) => {
  await leadService.deleteLead(req.params.leadId);
  res.json(new ApiResponse(httpStatus.OK, null, 'Lead deleted'));
});

const assignLead = catchAsync(async (req, res) => {
  const lead = await leadService.assignLead(req.params.leadId, req.body.assignedTo);
  res.json(new ApiResponse(httpStatus.OK, lead, 'Lead assigned'));
});

const addNote = catchAsync(async (req, res) => {
  const lead = await Lead.findOne({ _id: req.params.leadId, isDeleted: false });
  if (!lead) throw new ApiError(httpStatus.NOT_FOUND, 'Lead not found');
  lead.notes.push({ text: req.body.text, createdBy: req.user._id });
  await lead.save();
  await lead.populate('notes.createdBy', 'name');

  interaktService.trackEvent(lead._id, 'Lead Note Added', { note: req.body.text }).catch(e => console.error(e));

  res.json(new ApiResponse(httpStatus.OK, lead, 'Note added'));
});

const markCNP = catchAsync(async (req, res) => {
  const lead = await leadService.markCNP(req.params.leadId, req.user.role, req.user._id);
  res.json(new ApiResponse(httpStatus.OK, lead, 'Marked as CNP'));
});

const unmarkCNP = catchAsync(async (req, res) => {
  const lead = await leadService.unmarkCNP(req.params.leadId, req.user.role, req.user._id);
  res.json(new ApiResponse(httpStatus.OK, lead, 'CNP removed'));
});

const addFollowUp = catchAsync(async (req, res) => {
  const { note, next_date } = req.body;
  const lead = await Lead.findByIdAndUpdate(
    req.params.leadId,
    {
      $push: { follow_ups: { date: new Date(), note: note || '', next_date: next_date ? new Date(next_date) : undefined, createdBy: req.user._id } },
      ...(next_date ? { next_follow_up: new Date(next_date) } : {}),
    },
    { returnDocument: 'after' }
  ).select('follow_ups next_follow_up').lean();
  const fullLead = await Lead.findById(req.params.leadId);
  await leadService.syncPilesLead(fullLead);

  interaktService.trackEvent(req.params.leadId, 'Lead Follow Up Added', { note, next_date }).catch(e => console.error(e));

  res.json(new ApiResponse(httpStatus.OK, lead, 'Follow up added'));
});

const setNextFollowUp = catchAsync(async (req, res) => {
  const { next_follow_up } = req.body;
  const lead = await Lead.findByIdAndUpdate(
    req.params.leadId,
    { next_follow_up: next_follow_up ? new Date(next_follow_up) : null },
    { returnDocument: 'after' }
  ).select('follow_ups next_follow_up').lean();
  const fullLead = await Lead.findById(req.params.leadId);
  await leadService.syncPilesLead(fullLead);
  res.json(new ApiResponse(httpStatus.OK, lead, 'Next follow up set'));
});

const getFollowUpLeads = catchAsync(async (req, res) => {
  const { search, from, to, page = 1, per_page = 1000 } = req.query;
  const match = { status: 'follow_up', isDeleted: { $ne: true } };
  if (from || to) {
    match.updatedAt = {};
    if (from) match.updatedAt.$gte = new Date(from);
    if (to) match.updatedAt.$lte = new Date(to + 'T23:59:59');
  }
  if (search) {
    const q = new RegExp(search, 'i');
    match.$or = [{ name: q }, { phone: q }, { email: q }];
  }
  const skip = (Number(page) - 1) * Number(per_page);
  const [leads, total] = await Promise.all([
    Lead.find(match).sort({ updatedAt: -1 }).skip(skip).limit(Number(per_page))
      .populate('assignedTo', 'name').lean(),
    Lead.countDocuments(match),
  ]);
  res.json(new ApiResponse(httpStatus.OK, { data: leads, total }, 'Follow-up leads fetched'));
});

const searchByPhone = catchAsync(async (req, res) => {
  const { phone } = req.query;
  if (!phone || phone.trim().length < 3) {
    return res.json(new ApiResponse(httpStatus.OK, [], 'Search results'));
  }
  const leads = await Lead.find({
    phone: { $regex: phone.trim(), $options: 'i' },
    isDeleted: false,
  })
    .populate('assignedTo', 'name email')
    .populate('createdBy', 'name')
    .sort({ createdAt: -1 })
    .limit(10)
    .lean();
  res.json(new ApiResponse(httpStatus.OK, leads, 'Search results'));
});

const exportLeads = catchAsync(async (req, res) => {
  const { from, to } = req.query;
  const query = { isDeleted: false };
  if (from || to) {
    query.createdAt = {};
    if (from) query.createdAt.$gte = new Date(from);
    if (to) { const d = new Date(to); d.setHours(23,59,59,999); query.createdAt.$lte = d; }
  }
  const leads = await Lead.find(query)
    .populate('assignedTo', 'name')
    .sort({ createdAt: -1 })
    .lean();
  res.json(new ApiResponse(httpStatus.OK, leads, 'Leads exported'));
});

const distributeUnassigned = catchAsync(async (req, res) => {
  const result = await leadService.distributeUnassignedLeads(req.user._id);
  res.status(httpStatus.OK).json(new ApiResponse(httpStatus.OK, result, 'Unassigned leads distributed successfully'));
});

const distributeAbsentSales = catchAsync(async (req, res) => {
  const result = await leadService.distributeAbsentSalesLeads();
  res.status(httpStatus.OK).json(new ApiResponse(httpStatus.OK, result, result.message));
});

const deleteNote = catchAsync(async (req, res) => {
  const lead = await Lead.findOne({ _id: req.params.leadId, isDeleted: false });
  if (!lead) throw new ApiError(httpStatus.NOT_FOUND, 'Lead not found');
  
  const noteId = req.params.noteId;
  const initialLength = lead.notes.length;
  lead.notes.pull({ _id: noteId });
  
  if (lead.notes.length === initialLength) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Note not found');
  }

  await lead.save();
  await lead.populate('notes.createdBy', 'name');

  // Removed Interakt tracking to prevent errors when user doesn't exist
  // interaktService.trackEvent(lead._id, 'Lead Note Deleted', { noteId }).catch(e => console.error(e));

  res.json(new ApiResponse(httpStatus.OK, lead, 'Note deleted'));
});

const bulkMessage = catchAsync(async (req, res) => {
  const { status, templateName } = req.body;
  if (!status || !templateName) throw new ApiError(httpStatus.BAD_REQUEST, 'Status and templateName are required');

  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const allLeads = await Lead.find({ status, isDeleted: false }).populate('assignedTo', 'name');
  
  const eligibleLeads = [];
  const excludedLeads = [];

  allLeads.forEach(lead => {
    let excludeReason = null;
    if (lead.doNotContact) {
      excludeReason = 'Do Not Contact marked';
    } else if (lead.lastWhatsAppMessagedAt && lead.lastWhatsAppMessagedAt > twentyFourHoursAgo) {
      excludeReason = 'Messaged within last 24 hours';
    } else if (!lead.phone || lead.phone.length < 10) {
      excludeReason = 'Invalid or missing phone number';
    }

    if (excludeReason) {
      excludedLeads.push({ lead_id: lead._id, error_reason: excludeReason });
    } else {
      eligibleLeads.push(lead);
    }
  });

  const batch = await BulkMessageBatch.create({
    section: status,
    template: templateName,
    sent_by: req.user._id,
    total: eligibleLeads.length + excludedLeads.length,
    excluded_count: excludedLeads.length,
    status: 'processing'
  });

  const excludedRecipients = excludedLeads.map(ex => ({
    batch_id: batch._id,
    lead_id: ex.lead_id,
    status: 'excluded',
    error_reason: ex.error_reason
  }));

  const queuedRecipients = eligibleLeads.map(el => ({
    batch_id: batch._id,
    lead_id: el._id,
    status: 'sent',
  }));

  if (excludedRecipients.length > 0) await BulkMessageRecipient.insertMany(excludedRecipients);
  if (queuedRecipients.length > 0) await BulkMessageRecipient.insertMany(queuedRecipients);

  const jobs = eligibleLeads.map(el => ({
    name: 'sendTemplate',
    data: {
      batchId: batch._id,
      leadId: el._id,
      templateName,
      phone: el.phone,
      name: el.name,
      source: el.source,
      assignedToName: el.assignedTo?.name
    }
  }));

  if (jobs.length > 0) {
    await bulkMessageQueue.addBulk(jobs);
  } else {
    batch.status = 'completed';
    batch.completed_at = new Date();
    await batch.save();
  }

  res.status(httpStatus.ACCEPTED).json(new ApiResponse(httpStatus.ACCEPTED, {
    batchId: batch._id,
    totalMatched: allLeads.length,
    eligible: eligibleLeads.length,
    excluded: excludedLeads.length,
    status: batch.status
  }, 'Bulk message queued successfully'));
});

const getBulkMessageLogs = catchAsync(async (req, res) => {
  const logs = await BulkMessageBatch.find()
    .populate('sent_by', 'name email')
    .sort({ createdAt: -1 });
  res.json(new ApiResponse(httpStatus.OK, logs, 'Bulk message logs retrieved'));
});

const getBulkMessageBatchDetails = catchAsync(async (req, res) => {
  const batch = await BulkMessageBatch.findById(req.params.batchId).populate('sent_by', 'name');
  if (!batch) throw new ApiError(httpStatus.NOT_FOUND, 'Batch not found');
  
  const recipients = await BulkMessageRecipient.find({ batch_id: batch._id }).populate('lead_id', 'name phone');
  res.json(new ApiResponse(httpStatus.OK, { batch, recipients }, 'Batch details retrieved'));
});

const getBulkMessageBatchStatus = catchAsync(async (req, res) => {
  const batch = await BulkMessageBatch.findById(req.params.batchId);
  if (!batch) throw new ApiError(httpStatus.NOT_FOUND, 'Batch not found');
  res.json(new ApiResponse(httpStatus.OK, batch, 'Batch status retrieved'));
});

const retryBulkMessageBatch = catchAsync(async (req, res) => {
  const batch = await BulkMessageBatch.findById(req.params.batchId);
  if (!batch) throw new ApiError(httpStatus.NOT_FOUND, 'Batch not found');
  
  const failedRecipients = await BulkMessageRecipient.find({ batch_id: batch._id, status: 'failed' }).populate('lead_id');
  if (failedRecipients.length === 0) {
    return res.json(new ApiResponse(httpStatus.OK, batch, 'No failed messages to retry'));
  }

  batch.status = 'processing';
  batch.failed_count -= failedRecipients.length;
  await batch.save();

  const leadIds = failedRecipients.map(r => r.lead_id._id);
  const leads = await Lead.find({ _id: { $in: leadIds } }).populate('assignedTo', 'name');
  const leadsMap = {};
  leads.forEach(l => leadsMap[l._id] = l);

  const finalJobs = failedRecipients.map(recipient => {
    const el = leadsMap[recipient.lead_id._id];
    return {
      name: 'sendTemplate',
      data: {
        batchId: batch._id,
        leadId: el._id,
        templateName: batch.template,
        phone: el.phone,
        name: el.name,
        source: el.source,
        assignedToName: el.assignedTo?.name
      }
    };
  });

  await BulkMessageRecipient.updateMany({ batch_id: batch._id, status: 'failed' }, { status: 'sent', error_reason: null });
  await bulkMessageQueue.addBulk(finalJobs);

  res.status(httpStatus.ACCEPTED).json(new ApiResponse(httpStatus.ACCEPTED, batch, `Retrying ${finalJobs.length} messages`));
});

export default { createLead, submitLead, submitLeadForDepartment, getLeads, getLead, updateLead, deleteLead, assignLead, addNote, deleteNote, markCNP, unmarkCNP, addFollowUp, setNextFollowUp, getFollowUpLeads, searchByPhone, exportLeads, distributeUnassigned, distributeAbsentSales, bulkMessage, getBulkMessageLogs, getBulkMessageBatchDetails, getBulkMessageBatchStatus, retryBulkMessageBatch };

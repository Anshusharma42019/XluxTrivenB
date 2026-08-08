import express from 'express';
import auth from '../../middleware/auth.js';
import requireCheckedIn from '../../middleware/requireCheckedIn.js';
import departmentFilter from '../../middleware/departmentFilter.js';
import CallAgain from './callagain.model.js';
import { Lead } from '../lead/lead.model.js';

const router = express.Router();

// GET all call-again records
router.get('/', auth('admin', 'manager', 'sales', 'support'), departmentFilter, async (req, res) => {
  try {
    const query = { status: { $nin: ['done', 'completed', 'archived'] }, isDeleted: { $ne: true }, isArchived: { $ne: true } };
    const { filter, department } = req.query;

    const userDepts = ['sales', 'support', 'logistics'].includes(req.user.role) ? req.userDepartments : (department ? [department] : []);
    if (userDepts && userDepts.length > 0) {
      query.department = { $in: userDepts };
    }
    
    if (filter) {
      const now = new Date();
      const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
      if (filter === 'today') query.createdAt = { $gte: startOfDay(now) };
      else if (filter === 'yesterday') {
        const start = startOfDay(new Date(now - 86400000));
        query.createdAt = { $gte: start, $lt: startOfDay(now) };
      } else if (filter === 'this_week') {
        query.createdAt = { $gte: startOfDay(new Date(now - now.getDay() * 86400000)) };
      } else if (filter === 'this_month') {
        query.createdAt = { $gte: new Date(now.getFullYear(), now.getMonth(), 1) };
      }
    }
    if (req.query.month !== undefined) {
      const m = parseInt(req.query.month);
      const now = new Date();
      query.createdAt = { $gte: new Date(now.getFullYear(), m, 1), $lt: new Date(now.getFullYear(), m + 1, 1) };
    }
    const limitVal = parseInt(req.query.limit) || 200;
    const records = await CallAgain.find(query)
      .populate('lead', 'name phone problem email address houseNo cityVillage postOffice landmark district state pincode source status type revenue cnpCount cnpAt note createdAt department')
      .populate('assignedTo', 'name email')
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 })
      .limit(limitVal);

    const uniqueLeads = new Set();
    const cleanRecords = [];
    const duplicateIds = [];
    for (const r of records) {
      const leadKey = r.lead?._id ? String(r.lead._id) : (r.lead ? String(r.lead) : String(r._id));
      if (uniqueLeads.has(leadKey)) {
        duplicateIds.push(r._id);
      } else {
        uniqueLeads.add(leadKey);
        cleanRecords.push(r);
      }
    }
    if (duplicateIds.length > 0) {
      CallAgain.updateMany({ _id: { $in: duplicateIds } }, { $set: { isDeleted: true, isArchived: true } }).catch(() => {});
    }

    res.json({ status: 200, data: cleanRecords });
  } catch (e) {
    res.status(500).json({ status: 500, message: e.message });
  }
});

// POST create a call-again record from a lead
router.post('/', auth('admin', 'manager', 'sales', 'support'), requireCheckedIn, async (req, res) => {
  try {
    const { leadId, notes } = req.body;
    if (!leadId) return res.status(400).json({ message: 'leadId is required' });

    let targetId = leadId;
    let lead = await Lead.findById(targetId);
    if (!lead) {
      const { STATUS_ROUTING_MATRIX } = await import('../transition/transition.service.js');
      for (const k in STATUS_ROUTING_MATRIX) {
        try {
          const doc = await STATUS_ROUTING_MATRIX[k].model?.findById(targetId);
          if (doc && (doc.name || doc.phone || doc.email || doc.problem)) {
            lead = doc;
            break;
          } else if (doc && doc.lead) {
            targetId = doc.lead;
            lead = await Lead.findById(targetId);
            if (lead) break;
          }
        } catch (e) {}
      }
    }
    if (!lead) return res.status(404).json({ message: 'Lead not found' });
    const resolvedLeadId = lead._id;

    const updatePayload = { 
      lead: resolvedLeadId, 
      assignedTo: lead.assignedTo?._id || lead.assignedTo, 
      department: lead.department, 
      status: 'pending', 
      createdBy: req.user._id,
      isDeleted: false,
      isArchived: false
    };
    if (notes && Array.isArray(notes)) {
      updatePayload.notes = notes;
    }

    // Upsert — one record per lead
    const record = await CallAgain.findOneAndUpdate(
      { lead: resolvedLeadId },
      updatePayload,
      { upsert: true, returnDocument: 'after' }
    ).populate('lead', 'name phone problem department').populate('assignedTo', 'name email').populate('createdBy', 'name email');
    // Execute transition synchronously before responding so frontend reload gets the updated list instantly
    const { transitionRecord } = await import('../transition/transition.service.js');
    await transitionRecord(Lead, resolvedLeadId, 'call_again', { status: 'follow_up', cnp: false }, req.user?._id || null).catch(() => {});

    const { default: Task } = await import('../task/task.model.js');
    await Task.updateMany({ lead: resolvedLeadId, status: { $in: ['pending', 'overdue'] }, isDeleted: false }, { status: 'cancel_call' }).catch(() => {});

    res.json({ status: 200, data: record });
  } catch (e) {
    res.status(500).json({ status: 500, message: e.message });
  }
});

// PATCH update status
router.patch('/:id', auth('admin', 'manager', 'sales', 'support'), requireCheckedIn, async (req, res) => {
  try {
    const { status } = req.body;
    const record = await CallAgain.findByIdAndUpdate(
      req.params.id,
      { status },
      { returnDocument: 'after' }
    ).populate('lead', 'name phone department').populate('assignedTo', 'name email');

    if (!record) return res.status(404).json({ message: 'Not found' });

    // Sync lead status (skip for 'done' status)
    if (record.lead && status !== 'done') {
      const leadStatus = status === 'converted' ? 'closed_won' : status === 'closed_lost' ? 'closed_lost' : status;
      await Lead.findByIdAndUpdate(record.lead._id || record.lead, { status: leadStatus, cnp: false });
    }

    if (status && record && record._id) {
      try {
        const { transitionRecord } = await import('../transition/transition.service.js');
        await transitionRecord(CallAgain, record._id, status, {}, req.user?._id || req.user || null);
      } catch (transErr) {
        console.error('[transitionRecord] CallAgain transition note:', transErr.message);
      }
    }

    res.json({ status: 200, data: record });
  } catch (e) {
    res.status(500).json({ status: 500, message: e.message });
  }
});

export default router;

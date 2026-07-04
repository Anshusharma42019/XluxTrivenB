import httpStatus from 'http-status';
import mongoose from 'mongoose';
import Lead from './lead.model.js';
import PilesLead from './pilesLead.model.js';
import Task from '../task/task.model.js';
import Cnp from '../cnp/cnp.model.js';
import Verification from '../verification/verification.model.js';
import CallAgain from '../callagain/callagain.model.js';
import User from '../user/user.model.js';
import Attendance from '../attendance/attendance.model.js';
import ApiError from '../../utils/ApiError.js';
import { createNotification } from '../notification/notification.service.js';
import * as interaktService from '../interakt/interakt.service.js';

const notifyAdmins = async (data) => {
  const admins = await User.find({ role: { $in: ['admin', 'manager'] }, isDeleted: false }, '_id');
  await Promise.all(admins.map(a => createNotification({ ...data, user: a._id }).catch(() => {})));
};

const toPilesLeadPayload = (lead) => ({
  lead: lead._id,
  name: lead.name,
  phone: lead.phone,
  email: lead.email,
  address: lead.address,
  houseNo: lead.houseNo,
  cityVillage: lead.cityVillage,
  cityVillageType: lead.cityVillageType,
  postOffice: lead.postOffice,
  landmark: lead.landmark,
  district: lead.district,
  state: lead.state,
  pincode: lead.pincode,
  source: lead.source,
  status: lead.status,
  note: lead.note,
  problem: lead.problem,
  type: lead.type,
  revenue: lead.revenue,
  cnp: lead.cnp,
  cnpCount: lead.cnpCount,
  cnpAt: lead.cnpAt,
  next_follow_up: lead.next_follow_up,
  onHoldReason: lead.onHoldReason,
  onHoldUntil: lead.onHoldUntil,
  assignedTo: lead.assignedTo?._id || lead.assignedTo,
  createdBy: lead.createdBy?._id || lead.createdBy,
  isDeleted: lead.isDeleted,
  deletedAt: lead.deletedAt,
});

export const syncPilesLead = async (lead) => {
  if (!lead?._id) return;
  if (lead.department === 'piles') {
    await PilesLead.findOneAndUpdate(
      { lead: lead._id },
      { $set: toPilesLeadPayload(lead) },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    );
  } else {
    await PilesLead.findOneAndUpdate(
      { lead: lead._id },
      { $set: { isDeleted: true, deletedAt: new Date() } }
    );
  }
};

// Auto-detect department from the problem description text
const detectDepartmentFromProblem = (problem) => {
  if (!problem) return null;
  const text = problem.toLowerCase();
  const migraineKeywords = ['migraine', 'माइग्रेन', 'migrain', 'headache', 'sir dard', 'sir me dard', 'sar dard', 'aadha sir'];
  const pilesKeywords = ['piles', 'बवासीर', 'bawasir', 'bavasir', 'hemorrhoid', 'bleeding piles', 'fissure', 'fistula', 'bhagander'];
  if (migraineKeywords.some(kw => text.includes(kw))) return 'migraine';
  if (pilesKeywords.some(kw => text.includes(kw))) return 'piles';
  return null;
};

// TRUE Round Robin — assigns to the user who was assigned a lead least recently
export const getNextSalesUser = async (department = null) => {
  const query = { role: 'sales', isDeleted: false };
  if (department) {
    query.departments = { $in: [department] };
  }
  const salesUsers = await User.find(query).sort({ createdAt: 1 });
  if (!salesUsers.length) return null;

  // Find users who are checked in and not checked out today
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);

  const activeAttendances = await Attendance.find({
    user: { $in: salesUsers.map(u => u._id) },
    checkIn: { $ne: null },
    checkOut: null,
    isDeleted: false,
    $or: [
      { date: { $gte: startOfDay, $lte: endOfDay } },
      { checkIn: { $gte: startOfDay } },
    ],
  });

  const activeUserIds = activeAttendances.map(a => a.user.toString());
  const activeSalesUsers = salesUsers.filter(u => activeUserIds.includes(u._id.toString()));

  // Fallback: If no one is checked in, fallback to all active sales users 
  // so night leads are always assigned to someone for the morning.
  const eligibleUsers = activeSalesUsers.length > 0 ? activeSalesUsers : salesUsers;

  // Round Robin: pick user with oldest (or null) lastLeadAssignedAt
  // null = never assigned → highest priority (-Infinity)
  let selectedUser = eligibleUsers[0];
  for (let i = 1; i < eligibleUsers.length; i++) {
    const u = eligibleUsers[i];
    const selectedTime = selectedUser.lastLeadAssignedAt ? selectedUser.lastLeadAssignedAt.getTime() : -Infinity;
    const uTime = u.lastLeadAssignedAt ? u.lastLeadAssignedAt.getTime() : -Infinity;
    if (uTime < selectedTime) {
      selectedUser = u;
    }
  }

  // Stamp this user immediately so next call rotates to next person
  await User.findByIdAndUpdate(selectedUser._id, { lastLeadAssignedAt: new Date() });

  return selectedUser._id;
};

export const createLead = async (data, createdBy, creatorRole, userDepartments = []) => {
  // Normalize phone: strip +91/91 prefix, keep last 10 digits
  if (data.phone) {
    let p = data.phone.replace(/\s+/g, '').trim();
    if (p.startsWith('+91')) p = p.substring(3);
    else if (p.startsWith('91') && p.length === 12) p = p.substring(2);
    else if (p.startsWith('+')) p = p.substring(1);
    data.phone = p.slice(-10);
  }

  // Duplicate check using last-10-digits regex so +91XXXXXXXXXX and XXXXXXXXXX match the same lead
  const last10 = data.phone?.slice(-10);
  const existingLead = last10
    ? await Lead.findOne({ phone: { $regex: last10 + '$' }, isDeleted: false })
    : null;
  if (existingLead) throw new ApiError(httpStatus.CONFLICT, 'A lead with this phone number already exists');

  if (!data.assignedTo) {
    // Auto-detect department from problem field if not already set
    if (!data.department && data.problem) {
      const detected = detectDepartmentFromProblem(data.problem);
      if (detected) data.department = detected;
    }

    // If Admin/Manager adds a lead, auto-distribute it.
    // If regular staff (sales/support) manually adds a lead, assign it to themselves.
    if (createdBy && creatorRole !== 'admin' && creatorRole !== 'manager') {
      data.assignedTo = createdBy;
      // Only override department if the user didn't explicitly select one in the form
      if (!data.department && userDepartments && userDepartments.length > 0) {
        data.department = userDepartments[0] || null;
      }
    } else {
      data.assignedTo = await getNextSalesUser(data.department);
      // Removed fallback to Admin/Creator so night leads stay unassigned.
    }
  } else if (creatorRole === 'sales' && userDepartments && userDepartments.length > 0) {
    // Only fall back to user's department if not provided in form
    if (!data.department) data.department = userDepartments[0] || null;
  }

  if (!data.department) delete data.department;
  const payload = { ...data };
  if (createdBy) payload.createdBy = createdBy;

  const lead = await Lead.create(payload);
  await syncPilesLead(lead);

  // Track the user in Interakt when a new lead is created
  interaktService.trackUser(lead).catch(err => console.error('Failed to track user in Interakt', err));

  if (lead.assignedTo) {
    // Notify assigned sales person
    await createNotification({
      user: lead.assignedTo,
      title: 'New Lead Assigned',
      message: `Lead "${lead.name}" has been assigned to you.`,
      type: 'lead_assigned',
      relatedLead: lead._id,
    }).catch(() => {});
    
    await notifyAdmins({ title: 'New Lead Created', message: `Lead "${lead.name}" was created and assigned.`, type: 'lead_assigned', relatedLead: lead._id });
  } else {
    // Notify admins that a new UNASSIGNED lead arrived
    await notifyAdmins({ title: 'New Unassigned Lead', message: `Lead "${lead.name}" was created but is unassigned.`, type: 'lead_assigned', relatedLead: lead._id });
  }

  if (lead.assignedTo) {

    // Auto-create a CALL task — only if no active task already exists for this lead
    const assignedToId = lead.assignedTo._id ?? lead.assignedTo;
    if (assignedToId) {
      const existingTask = await Task.findOne({ lead: lead._id, status: { $in: ['pending', 'overdue', 'verification', 'ready_to_shipment', 'cnp', 'interested', 'on_hold'] }, isDeleted: false });
      if (!existingTask) {
        const dueDate = new Date(Date.now() + 2 * 60 * 60 * 1000);
        const taskCreatedBy = createdBy
          ? new mongoose.Types.ObjectId(String(createdBy))
          : assignedToId;
        await Task.create({
          title: `Call ${lead.name}`,
          description: `Phone: ${lead.phone}${lead.problem ? ' | ' + lead.problem : ''}`,
          type: 'call',
          lead: lead._id,
          assignedTo: assignedToId,
          createdBy: taskCreatedBy,
          department: lead.department,
          dueDate,
          priority: 'high',
          status: 'pending',
          isDeleted: false,
        });
      }
    } else {
      console.warn('[AUTO-TASK] Skipped — no sales user available for lead:', lead._id);
    }
  }

  return lead;
};

export const distributeUnassignedLeads = async (adminId) => {
  // Find all unassigned leads that are "new" and not deleted, OR leads assigned to the admin
  const unassignedLeads = await Lead.find({ assignedTo: { $in: [null, adminId] }, status: 'new', isDeleted: false }).sort({ createdAt: 1 });
  let distributedCount = 0;

  for (const lead of unassignedLeads) {
    const assignedToId = await getNextSalesUser(lead.department);
    if (assignedToId) {
      // Assign lead
      lead.assignedTo = assignedToId;
      await lead.save();

      // Create a Call Task only if no active task already exists for this lead
      const existingTask = await Task.findOne({ lead: lead._id, status: { $in: ['pending', 'overdue', 'verification', 'ready_to_shipment', 'cnp', 'interested', 'on_hold'] }, isDeleted: false });
      const dueDate = new Date(Date.now() + 2 * 60 * 60 * 1000);
      const task = existingTask
        ? existingTask
        : await Task.create({
          title: `Call ${lead.name}`,
          description: `Phone: ${lead.phone}${lead.problem ? ' | ' + lead.problem : ''}`,
          type: 'call',
          lead: lead._id,
          assignedTo: assignedToId,
          createdBy: adminId || assignedToId,
          department: lead.department,
          dueDate,
          priority: 'high',
          status: 'pending',
          isDeleted: false,
        });

      // Send notification
      await createNotification({
        user: assignedToId,
        title: 'New Lead Assigned (Night Distribution)',
        message: `You have been assigned a pending lead: ${lead.name}`,
        type: 'lead_assigned',
        relatedLead: lead._id,
        relatedTask: task._id,
      });

      distributedCount++;
    }
  }
  return { success: true, message: `Successfully distributed ${distributedCount} leads.` };
};

export const distributeAbsentSalesLeads = async () => {
  console.log("Starting distributeAbsentSalesLeads");
  // Find users who are checked in and not checked out today
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);
  
  console.log("Fetching all sales users");
  const allSalesUsers = await User.find({ role: 'sales', isDeleted: false }, '_id');
  console.log("Found sales users:", allSalesUsers.length);
  
  const activeAttendances = await Attendance.find({
    user: { $in: allSalesUsers.map(u => u._id) },
    checkIn: { $ne: null },
    checkOut: null,
    isDeleted: false,
    $or: [
      { date: { $gte: startOfDay, $lte: endOfDay } },
      { checkIn: { $gte: startOfDay } },
    ],
  });

  const activeUserIds = activeAttendances.map(a => a.user.toString());
  
  // Sales users who are NOT checked in
  const absentUserIds = allSalesUsers
    .filter(u => !activeUserIds.includes(u._id.toString()))
    .map(u => u._id);
  console.log("Absent User IDs:", absentUserIds.length);

  if (absentUserIds.length === 0) {
    return { success: true, message: 'No absent sales users found.' };
  }
  
  if (activeUserIds.length === 0) {
    return { success: true, message: 'No active sales users to redistribute leads to.' };
  }

  // Include yesterday and today to catch leads assigned after their shift yesterday
  const startOfYesterday = new Date(startOfDay);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);

  const leadsToRedistribute = await Lead.find({ 
    assignedTo: { $in: absentUserIds }, 
    status: 'new', 
    createdAt: { $gte: startOfYesterday, $lte: endOfDay },
    isDeleted: false 
  }).sort({ createdAt: 1 });
  console.log("Leads to redistribute:", leadsToRedistribute.length);

  let distributedCount = 0;

  for (const lead of leadsToRedistribute) {
    const assignedToId = await getNextSalesUser(lead.department);
    
    // Safety check: ensure we don't accidentally re-assign to an absent user
    // if getNextSalesUser somehow falls back (it shouldn't if active users exist)
    if (assignedToId && !absentUserIds.some(id => id.equals(assignedToId))) {
      lead.assignedTo = assignedToId;
      await lead.save();

      // Update existing Task or create new one
      const existingTask = await Task.findOne({ lead: lead._id, status: { $in: ['pending', 'overdue', 'verification', 'ready_to_shipment', 'cnp', 'interested', 'on_hold'] }, isDeleted: false });
      
      if (existingTask) {
        existingTask.assignedTo = assignedToId;
        await existingTask.save();
      } else {
        const dueDate = new Date(Date.now() + 2 * 60 * 60 * 1000);
        await Task.create({
          title: `Call ${lead.name}`,
          description: `Phone: ${lead.phone}${lead.problem ? ' | ' + lead.problem : ''}`,
          type: 'call',
          lead: lead._id,
          assignedTo: assignedToId,
          createdBy: assignedToId,
          department: lead.department,
          dueDate,
          priority: 'high',
          status: 'pending',
          isDeleted: false,
        });
      }

      // Send notification
      await createNotification({
        user: assignedToId,
        title: 'Redistributed Lead Assigned',
        message: `Lead ${lead.name} reassigned to you due to absence.`,
        type: 'lead_assigned',
        relatedLead: lead._id,
      });

      distributedCount++;
    }
  }

  return { success: true, message: `Successfully redistributed ${distributedCount} leads from absent staff.` };
};

export const getLeads = async (filter, options, userRole, userId, userDepartments = []) => {
  const query = { isDeleted: false };

  if (filter.whatsappOnly === 'true' || filter.whatsappOnly === true) {
    query.$and = query.$and || [];
    query.$and.push({
      $or: [
        { 'notes.direction': 'outbound' },
        { 'notes.text': /\[Interakt Message\]|\[Attached Media/ },
        { problem: /\[Interakt Message\]/ },
        { source: 'social_media' }
      ]
    });
  }

  // Sales can see all leads for shared statuses (interested, closed_lost, on_hold)
  const sharedStatuses = ['interested', 'closed_lost', 'on_hold'];
  const isSharedStatus = filter.status && sharedStatuses.includes(filter.status);
  
  if (userRole === 'sales') {
    if (!isSharedStatus) query.assignedTo = userId;
    // Removed department filter here so sales can always see leads assigned to them even if department is null
  } else if (filter.department) {
    query.department = filter.department;
  } else if (userDepartments && userDepartments.length > 0) {
    query.department = { $in: userDepartments };
  }

  // Export mode: skip all status/pipeline filters, return everything
  const isExport = filter.export === 'true';
  const isWhatsapp = filter.whatsappOnly === 'true' || filter.whatsappOnly === true;

  if (!isExport && !isWhatsapp) {
    if (!filter.cnp) query.cnp = { $ne: true };

    if (filter.status) {
      query.status = filter.status;
    } else if (!filter.cnp) {
      query.status = { $nin: ['closed_won', 'closed_lost', 'interested', 'follow_up', 'on_hold'] };
    }
  }
  if (filter.source) query.source = filter.source;
  if (filter.assignedTo && userRole !== 'sales') query.assignedTo = filter.assignedTo;
  if (filter.cnp === 'true') query.cnp = true;

  // Always exclude leads that are in verification/shipment pipeline (unless fetching CNP list or exporting)
  if (!filter.cnp && !isExport && !isWhatsapp) {
    const isOnHold = filter.status === 'on_hold';
    const isInterested = filter.status === 'interested';

    // For on_hold: get lead IDs that have a verification record with on_hold status (these SHOULD show)
    const verificationOnHoldLeadIds = isOnHold
      ? (await Verification.distinct('lead', { status: 'on_hold', lead: { $ne: null } })).map(String)
      : [];

    // Remove cnp leads from whitelist
    const cnpLeadIds = isOnHold && verificationOnHoldLeadIds.length
      ? (await Lead.find({ _id: { $in: verificationOnHoldLeadIds }, cnp: true }, '_id').lean()).map(l => String(l._id))
      : [];
    const safeWhitelist = verificationOnHoldLeadIds.filter(id => !cnpLeadIds.includes(id));

    // Optimize exclusion list: Only lookup tasks/cnp/verification for the current user's leads (or departments) to drastically reduce array sizes
    const matchFilter = { lead: { $ne: null } };
    if (userRole === 'sales') {
      matchFilter.assignedTo = userId;
    } else if (filter.department) {
      matchFilter.department = filter.department;
    }
    matchFilter.isDeleted = false;

    const [excludeByTask, excludeByCnpCollection, excludeByVerification] = await Promise.all([
      isInterested
        ? Task.distinct('lead', { ...matchFilter, status: { $in: ['pending', 'overdue', 'verification', 'ready_to_shipment'] } })
        : isOnHold
          ? Task.distinct('lead', { ...matchFilter, status: { $in: ['verification', 'ready_to_shipment', 'interested'] } })
          : Task.distinct('lead', { ...matchFilter, status: { $in: ['cnp', 'verification', 'ready_to_shipment', 'interested'] } }),
      isOnHold ? Promise.resolve([]) : Cnp.distinct('lead', { lead: { $ne: null }, ...(userRole === 'sales' ? { assignedTo: userId } : {}) }),
      isOnHold
        ? Promise.resolve([])
        : Verification.distinct('lead', { lead: { $exists: true, $ne: null }, status: { $nin: ['on_hold'] } }),
    ]);

    // Use a Set for faster lookups instead of .includes() on a massive array
    const excludeSet = new Set([
      ...excludeByTask.map(String),
      ...excludeByCnpCollection.map(String),
      ...excludeByVerification.map(String)
    ]);
    
    safeWhitelist.forEach(id => excludeSet.delete(id));

    if (excludeSet.size > 0) {
      const allExcludeIds = Array.from(excludeSet).map(id => new mongoose.Types.ObjectId(id));
      query._id = query._id
        ? { $nin: [...(query._id.$nin || []), ...allExcludeIds] }
        : { $nin: allExcludeIds };
    }
  }

  if (filter.search) {
    query.$or = [
      { name: { $regex: filter.search, $options: 'i' } },
      { phone: { $regex: filter.search, $options: 'i' } },
      { email: { $regex: filter.search, $options: 'i' } },
    ];
  }
  if (filter.dateFrom || filter.dateTo) {
    query.createdAt = {};
    if (filter.dateFrom) query.createdAt.$gte = new Date(filter.dateFrom);
    if (filter.dateTo) {
      const to = new Date(filter.dateTo);
      to.setHours(23, 59, 59, 999);
      query.createdAt.$lte = to;
    }
  }

  const page = parseInt(options.page) || 1;
  const limit = parseInt(options.limit) || 20;
  const skip = (page - 1) * limit;

  const sortCriteria = isWhatsapp ? { updatedAt: -1 } : { createdAt: -1 };

  const [leads, total] = await Promise.all([
    Lead.find(query)
      .populate('assignedTo', 'name email role')
      .populate('createdBy', 'name email')
      .sort(sortCriteria)
      .skip(skip)
      .limit(limit),
    Lead.countDocuments(query),
  ]);

  return { leads, total, page, limit, totalPages: Math.ceil(total / limit) };
};

export const getLeadById = async (id, userRole, userId, userDepartments = []) => {
  const lead = await Lead.findOne({ _id: id, isDeleted: false })
    .populate('assignedTo', 'name email role')
    .populate('createdBy', 'name email')
    .populate('notes.createdBy', 'name');
  if (!lead) throw new ApiError(httpStatus.NOT_FOUND, 'Lead not found');
  // Sales can view shared-status leads (interested, closed_lost, on_hold) from all staff
  const sharedStatuses = ['interested', 'closed_lost', 'on_hold'];
  
  if (userRole === 'sales') {
    // Removed department restriction so sales can view leads assigned to them
    if (!sharedStatuses.includes(lead.status) && String(lead.assignedTo?._id) !== String(userId)) {
      throw new ApiError(httpStatus.FORBIDDEN, 'Access denied');
    }
  }
  return lead;
};

export const updateLead = async (id, data, userRole, userId, userDepartments = []) => {
  const lead = await Lead.findOne({ _id: id, isDeleted: false })
    .populate('assignedTo', 'name email role');
  if (!lead) throw new ApiError(httpStatus.NOT_FOUND, 'Lead not found');
  
  if (userRole === 'sales') {
    // Removed department restriction so sales can edit leads assigned to them
    if (!['closed_lost', 'interested', 'on_hold'].includes(data.status) && String(lead.assignedTo?._id) !== String(userId)) {
      throw new ApiError(httpStatus.FORBIDDEN, 'Access denied');
    }
  }
  // Normalize assignedTo — accept object {_id} or string
  if (data.assignedTo && typeof data.assignedTo === 'object') {
    data.assignedTo = data.assignedTo._id;
  }
  if (data.department === '') delete data.department;
  // Sales users can only assign to themselves
  if (userRole === 'sales') {
    data.assignedTo = new mongoose.Types.ObjectId(String(userId));
  }
  const oldStatus = lead.status;

  // When moving to on_hold, force cnp=false and clean up CNP records/tasks BEFORE saving
  if (data.status === 'on_hold') {
    data.cnp = false;
    const leadObjId = new mongoose.Types.ObjectId(String(id));
    await Cnp.deleteMany({ lead: leadObjId });
    await CallAgain.deleteMany({ lead: leadObjId });
    await Task.updateMany(
      { lead: leadObjId, status: { $in: ['pending', 'overdue', 'cnp'] }, isDeleted: false },
      { isDeleted: true }
    );
  }

  // When clearing CNP flag (from any status), delete cnp-status tasks and remove CNP records BEFORE saving
  if (data.cnp === false) {
    await Task.deleteMany({ lead: id, status: 'cnp', isDeleted: false });
    await Cnp.deleteMany({ lead: id });
  }

  Object.assign(lead, data);
  await lead.save();
  await syncPilesLead(lead);

  // Track the update event in Interakt
  interaktService.trackEvent(lead._id, 'Lead Updated', {
    status: lead.status,
    department: lead.department,
    ...data
  }).catch(err => console.error('Failed to track event in Interakt', err));

  // When moving out of on_hold back to active (new/interested), sync verification record
  if (data.status && ['new', 'interested'].includes(data.status) && oldStatus === 'on_hold') {
    const leadObjId = new mongoose.Types.ObjectId(String(id));
    if (data.status === 'new') {
      const details = {
        houseNo: lead.houseNo,
        cityVillage: lead.cityVillage,
        cityVillageType: lead.cityVillageType,
        postOffice: lead.postOffice,
        district: lead.district,
        state: lead.state,
        pincode: lead.pincode,
        landmark: lead.landmark,
        address: lead.address,
        problem: lead.problem,
        phone: lead.phone
      };

      // Move back to pending in verification if record exists
      await Verification.updateMany({ lead: leadObjId }, { status: 'pending', ...details });
      const verRecords = await Verification.find({ lead: leadObjId });
      for (const vr of verRecords) {
        if (vr.task) await Task.findByIdAndUpdate(vr.task, { status: 'verification', isDeleted: false, ...details });
      }
      // Also restore any soft-deleted call tasks so they show in Action Required
      await Task.updateMany(
        { lead: leadObjId, status: { $in: ['pending', 'overdue', 'cnp', 'on_hold'] }, isDeleted: true },
        { 
          status: data.forceVerification ? 'verification' : 'pending', 
          isDeleted: false,
          ...details
        }
      );
    } else {
      // Moving to interested - clean up verification so it shows in pipeline
      await Verification.deleteMany({ lead: leadObjId });
      await Task.updateMany(
        { lead: leadObjId, status: { $in: ['verification', 'pending', 'overdue', 'on_hold', 'cnp'] }, isDeleted: false },
        { isDeleted: true }
      );
    }
  }

  // When marking interested from CNP, soft-delete pending/overdue tasks so lead shows in pipeline
  if (data.status === 'interested' && data.cnp === false) {
    const leadObjId = new mongoose.Types.ObjectId(String(id));
    await Task.updateMany(
      { lead: leadObjId, status: { $in: ['pending', 'overdue', 'cnp'] }, isDeleted: false },
      { isDeleted: true }
    );
  }

  if (data.status && data.status !== oldStatus && lead.assignedTo) {
    await createNotification({
      user: lead.assignedTo,
      title: 'Lead Status Updated',
      message: `Lead "${lead.name}" moved to ${data.status}.`,
      type: 'lead_status_changed',
      relatedLead: lead._id,
    });
    await notifyAdmins({ title: 'Lead Status Updated', message: `Lead "${lead.name}" moved to ${data.status}.`, type: 'lead_status_changed', relatedLead: lead._id });
  }
  return lead;
};

export const markCNP = async (leadId, userRole, userId) => {
  const lead = await Lead.findOne({ _id: leadId, isDeleted: false });
  if (!lead) throw new ApiError(httpStatus.NOT_FOUND, 'Lead not found');
  lead.cnp = true;
  lead.cnpCount = (lead.cnpCount || 0) + 1;
  lead.cnpAt = new Date();
  await lead.save();
  await syncPilesLead(lead);

  // Track CNP marked event in Interakt
  interaktService.trackEvent(lead._id, 'Lead Marked CNP', {
    cnpCount: lead.cnpCount
  }).catch(err => console.error('Failed to track event in Interakt', err));

  // Mark any pending/overdue tasks for this lead as cnp
  const tasks = await Task.find(
    { lead: leadId, status: { $in: ['pending', 'overdue'] }, isDeleted: false }
  ).lean();

  await Task.updateMany(
    { lead: leadId, status: { $in: ['pending', 'overdue'] }, isDeleted: false },
    { status: 'cnp' }
  );

  // Create a Cnp record for each task (upsert to avoid duplicates)
  for (const task of tasks) {
    await Cnp.findOneAndUpdate(
      { task: task._id },
      {
        task: task._id,
        title: task.title,
        assignedTo: task.assignedTo,
        lead: leadId,
        dueDate: task.dueDate,
        department: lead.department || task.department || null,
        cnpCount: 1,
        lastCnpAt: new Date(),
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    );
  }

  // If no tasks exist, create a placeholder task then CNP record
  if (tasks.length === 0) {
    const placeholderTask = await Task.create({
      title: lead.name,
      type: 'call',
      lead: leadId,
      assignedTo: lead.assignedTo,
      createdBy: lead.assignedTo,
      department: lead.department,
      dueDate: new Date(),
      status: 'cnp',
      isDeleted: false,
    });
    await Cnp.findOneAndUpdate(
      { task: placeholderTask._id },
      {
        task: placeholderTask._id,
        title: lead.name,
        assignedTo: lead.assignedTo,
        lead: leadId,
        department: lead.department || null,
        cnpCount: 1,
        lastCnpAt: new Date(),
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    );
  }

  return lead;
};

export const unmarkCNP = async (leadId, userRole, userId) => {
  const lead = await getLeadById(leadId, userRole, userId);
  lead.cnp = false;
  await lead.save();
  await syncPilesLead(lead);
  return lead;
};

export const deleteLead = async (id) => {
  const lead = await Lead.findOne({ _id: id, isDeleted: false });
  if (!lead) throw new ApiError(httpStatus.NOT_FOUND, 'Lead not found');
  lead.isDeleted = true;
  lead.deletedAt = new Date();
  await lead.save();
  await syncPilesLead(lead);

  // Cascading soft-delete associated records
  const leadObjId = new mongoose.Types.ObjectId(String(id));
  await Promise.all([
    Task.updateMany({ lead: leadObjId, isDeleted: false }, { isDeleted: true, deletedAt: new Date() }),
    Verification.updateMany({ lead: leadObjId, isDeleted: false }, { isDeleted: true, deletedAt: new Date() }),
    Cnp.deleteMany({ lead: leadObjId }),
    CallAgain.deleteMany({ lead: leadObjId }),
  ]).catch(err => console.error('Cascading delete error:', err));
};

export const assignLead = async (leadId, assignedTo) => {
  const lead = await Lead.findOne({ _id: leadId, isDeleted: false });
  if (!lead) throw new ApiError(httpStatus.NOT_FOUND, 'Lead not found');
  lead.assignedTo = assignedTo;
  await lead.save();
  await syncPilesLead(lead);

  // Track assigned event in Interakt
  interaktService.trackEvent(lead._id, 'Lead Assigned', {
    assignedTo: assignedTo
  }).catch(err => console.error('Failed to track event in Interakt', err));

  await createNotification({
    user: assignedTo,
    title: 'Lead Assigned',
    message: `Lead "${lead.name}" has been assigned to you.`,
    type: 'lead_assigned',
    relatedLead: lead._id,
  });

  // Auto-create call task only if no active task already exists for this lead
  const existingCallTask = await Task.findOne({ lead: lead._id, status: { $in: ['pending', 'overdue', 'verification', 'ready_to_shipment', 'cnp', 'interested', 'on_hold'] }, isDeleted: false });
  if (!existingCallTask) {
    const dueDate = new Date(Date.now() + 2 * 60 * 60 * 1000);
    await Task.create({
      title: `Call ${lead.name}`,
      description: `Phone: ${lead.phone}${lead.problem ? ' | ' + lead.problem : ''}`,
      type: 'call',
      lead: lead._id,
      assignedTo,
      createdBy: assignedTo,
      department: lead.department,
      dueDate,
      priority: 'high',
      status: 'pending',
      isDeleted: false,
    });
  }

  return lead;
};

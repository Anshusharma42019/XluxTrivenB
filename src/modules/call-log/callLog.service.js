import mongoose from 'mongoose';
import CallLog from './callLog.model.js';
import User from '../user/user.model.js';
import Lead from '../lead/lead.model.js';
import Cnp from '../cnp/cnp.model.js';
import CallAgain from '../callagain/callagain.model.js';
import Verification from '../verification/verification.model.js';
import { InterestedLead, VerifiedOrder } from '../transition/statusModels.js';
import { Order as ShiprocketOrder } from '../shiprocket/models/order.model.js';

/**
 * Normalizes any phone string into a clean 10-digit Indian mobile number.
 */
export const cleanPhone = (raw) => {
  if (!raw) return null;
  const digitsOnly = String(raw).replace(/\D/g, '');
  if (digitsOnly.length >= 10) {
    return digitsOnly.slice(-10);
  }
  return digitsOnly.length >= 7 ? digitsOnly : null;
};

/**
 * Fast lookup across lead & order collections to match customer phone number.
 */
export const findLeadByPhone = async (cleanDigits) => {
  if (!cleanDigits) return null;

  // Flexible regex to match stored variations (e.g., "+91 98765 43210" or "9876543210")
  const phonePattern = cleanDigits.split('').join('[\\s\\-]*');
  const phoneReg = new RegExp(phonePattern, 'i');

  const matchQuery = { phone: phoneReg, isDeleted: { $ne: true } };

  // 1. Check Primary Leads
  const primaryLead = await Lead.findOne(matchQuery).select('_id name phone department notes cnpCount status').lean();
  if (primaryLead) {
    return {
      leadId: primaryLead._id,
      leadModel: 'Lead',
      leadName: primaryLead.name || 'Lead',
      department: primaryLead.department || null,
      rawDoc: primaryLead,
    };
  }

  // 2. Check CNP
  const cnpLead = await Cnp.findOne(matchQuery).select('_id name phone department notes cnpCount status').lean();
  if (cnpLead) {
    return {
      leadId: cnpLead._id,
      leadModel: 'Cnp',
      leadName: cnpLead.name || 'CNP Customer',
      department: cnpLead.department || null,
      rawDoc: cnpLead,
    };
  }

  // 3. Check CallAgain
  const callAgainLead = await CallAgain.findOne(matchQuery).select('_id name phone department notes status').lean();
  if (callAgainLead) {
    return {
      leadId: callAgainLead._id,
      leadModel: 'CallAgain',
      leadName: callAgainLead.name || 'CallAgain Customer',
      department: callAgainLead.department || null,
      rawDoc: callAgainLead,
    };
  }

  // 4. Check Verification
  const verificationLead = await Verification.findOne(matchQuery).select('_id name phone department notes status').lean();
  if (verificationLead) {
    return {
      leadId: verificationLead._id,
      leadModel: 'Verification',
      leadName: verificationLead.name || 'Verification Customer',
      department: verificationLead.department || null,
      rawDoc: verificationLead,
    };
  }

  // 5. Check Interested Leads
  const interestedLead = await InterestedLead.findOne(matchQuery).select('_id name phone department notes status').lean();
  if (interestedLead) {
    return {
      leadId: interestedLead._id,
      leadModel: 'InterestedLead',
      leadName: interestedLead.name || 'Interested Customer',
      department: interestedLead.department || null,
      rawDoc: interestedLead,
    };
  }

  // 6. Check Verified Orders
  const verifiedOrder = await VerifiedOrder.findOne(matchQuery).select('_id name phone department notes status').lean();
  if (verifiedOrder) {
    return {
      leadId: verifiedOrder._id,
      leadModel: 'VerifiedOrder',
      leadName: verifiedOrder.name || 'Verified Customer',
      department: verifiedOrder.department || null,
      rawDoc: verifiedOrder,
    };
  }

  // 7. Check Shiprocket Orders
  const srOrder = await ShiprocketOrder.findOne({
    $or: [{ billing_phone: phoneReg }, { customer_phone: phoneReg }],
  }).select('_id customer_name billing_customer_name billing_phone department').lean();
  if (srOrder) {
    return {
      leadId: srOrder._id,
      leadModel: 'ShiprocketOrder',
      leadName: srOrder.customer_name || srOrder.billing_customer_name || 'Order Customer',
      department: srOrder.department || null,
      rawDoc: srOrder,
    };
  }

  return null;
};

/**
 * Sync batch of call logs from an employee's Android APK.
 */
export const syncCallLogs = async (staffId, logs = []) => {
  if (!Array.isArray(logs) || logs.length === 0) {
    return { synced: 0, skipped: 0, duplicatesFound: 0 };
  }

  const staff = await User.findById(staffId).select('name role departments').lean();
  const staffName = staff?.name || 'Staff Member';
  const staffDept = staff?.departments?.[0] || null;

  let syncedCount = 0;
  let skippedCount = 0;
  let duplicateAlerts = 0;

  for (const item of logs) {
    const rawNumber = String(item.phone || item.phoneNumber || '').trim();
    const cleanNumber = cleanPhone(rawNumber);
    if (!cleanNumber) {
      skippedCount++;
      continue;
    }

    const duration = Math.max(0, parseInt(item.duration || 0, 10));
    const callType = ['outgoing', 'incoming', 'missed', 'rejected'].includes(item.callType?.toLowerCase())
      ? item.callType.toLowerCase()
      : 'outgoing';
    const timestamp = item.timestamp ? new Date(item.timestamp) : new Date();
    const simSlot = item.simSlot !== undefined ? parseInt(item.simSlot, 10) : 0;

    // 1. Prevent duplicate records of the exact same event
    const existingEntry = await CallLog.findOne({
      staffId,
      phoneNumber: cleanNumber,
      timestamp: {
        $gte: new Date(timestamp.getTime() - 2000),
        $lte: new Date(timestamp.getTime() + 2000),
      },
      duration,
    });

    if (existingEntry) {
      skippedCount++;
      continue;
    }

    // 2. Match with CRM Lead
    const matchedLead = await findLeadByPhone(cleanNumber);
    const leadId = matchedLead ? matchedLead.leadId : null;
    const leadModel = matchedLead ? matchedLead.leadModel : null;
    const leadName = matchedLead ? matchedLead.leadName : null;
    const effectiveDept = matchedLead?.department || staffDept || null;

    // 3. Duplicate Dial Check: Has any other agent dialed this customer in the last 48 hours?
    const fortyEightHoursAgo = new Date(timestamp.getTime() - 48 * 60 * 60 * 1000);
    const otherAgentCalls = await CallLog.find({
      phoneNumber: cleanNumber,
      staffId: { $ne: staffId },
      callType: 'outgoing',
      timestamp: { $gte: fortyEightHoursAgo, $lte: timestamp },
    }).select('staffId timestamp').lean();

    const isDuplicate = otherAgentCalls.length > 0;
    if (isDuplicate) duplicateAlerts++;

    const duplicateWithStaff = otherAgentCalls.map((c) => ({
      staffId: c.staffId,
      timestamp: c.timestamp,
    }));

    // 4. Determine status
    let callStatus = matchedLead ? 'processed' : 'unmatched';
    if (callType === 'missed') {
      callStatus = 'missed_pending';
    }

    // 5. Create CallLog entry
    const newLog = await CallLog.create({
      staffId,
      phoneNumber: cleanNumber,
      rawPhoneNumber: rawNumber,
      leadId,
      leadModel,
      leadName,
      callType,
      duration,
      timestamp,
      simSlot,
      department: effectiveDept,
      isDuplicate,
      duplicateWithStaff,
      status: callStatus,
      source: 'android_apk',
    });

    syncedCount++;

    // 6. Automated Lead Side-Effects (Zero Data Loss)
    try {
      if (leadId && leadModel === 'Lead') {
        const leadDoc = await Lead.findById(leadId);
        if (leadDoc) {
          if (callType === 'outgoing') {
            if (duration === 0) {
              // Auto CNP counter increment
              leadDoc.cnpCount = (leadDoc.cnpCount || 0) + 1;
              leadDoc.cnpAt = timestamp;
              leadDoc.notes.push({
                text: `[APK Auto-Log] Outgoing Call not answered (0s) — Dialed by ${staffName}`,
                createdBy: staffId,
                createdAt: timestamp,
                direction: 'outbound',
              });
            } else {
              // Connected Call
              const mins = Math.floor(duration / 60);
              const secs = duration % 60;
              leadDoc.notes.push({
                text: `[APK Auto-Log] Outgoing Call connected (${mins}m ${secs}s) — Handled by ${staffName}`,
                createdBy: staffId,
                createdAt: timestamp,
                direction: 'outbound',
              });
              // Auto-resolve any pending missed calls on this number
              await CallLog.updateMany(
                { phoneNumber: cleanNumber, status: 'missed_pending' },
                { $set: { status: 'missed_resolved', resolvedAt: timestamp, resolvedBy: staffId } }
              );
            }
          } else if (callType === 'missed') {
            leadDoc.notes.push({
              text: `[APK Auto-Log] Inbound Missed Call received from customer on ${staffName}'s device`,
              createdBy: staffId,
              createdAt: timestamp,
              direction: 'inbound',
            });
          }
          await leadDoc.save();
        }
      } else if (!leadId && callType === 'missed') {
        // Naya Number missed call -> Auto-create Inbound Lead so business never loses a customer
        try {
          await Lead.create({
            name: `Inbound Missed Call (${cleanNumber})`,
            phone: cleanNumber,
            source: 'inbound_missed_call',
            status: 'new',
            assignedTo: staffId,
            department: staffDept,
            notes: [
              {
                text: `[APK Auto-Log] Customer called ${staffName}'s device (Missed Call)`,
                createdBy: staffId,
                createdAt: timestamp,
                direction: 'inbound',
              },
            ],
          });
        } catch (e) {
          // Ignore unique phone conflicts if any
        }
      }
    } catch (err) {
      console.warn(`[CallLog] Auto-side-effect error for ${cleanNumber}:`, err.message);
    }
  }

  return { synced: syncedCount, skipped: skippedCount, duplicatesFound: duplicateAlerts };
};

/**
 * Telecalling Analytics & Staff Leaderboard
 */
export const getCallingStats = async ({ startDate, endDate, department, staffId }) => {
  const match = {};

  if (startDate || endDate) {
    match.timestamp = {};
    if (startDate) match.timestamp.$gte = new Date(startDate);
    if (endDate) match.timestamp.$lte = new Date(endDate);
  }

  if (department && department !== 'all') {
    match.department = department;
  }

  if (staffId) {
    match.staffId = new mongoose.Types.ObjectId(staffId);
  }

  // 1. Overall Metrics
  const summaryAgg = await CallLog.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        totalCalls: { $sum: 1 },
        totalTalkTime: { $sum: '$duration' },
        connectedCalls: {
          $sum: {
            $cond: [{ $and: [{ $eq: ['$callType', 'outgoing'] }, { $gt: ['$duration', 0] }] }, 1, 0],
          },
        },
        cnpCalls: {
          $sum: {
            $cond: [{ $and: [{ $eq: ['$callType', 'outgoing'] }, { $eq: ['$duration', 0] }] }, 1, 0],
          },
        },
        missedCalls: {
          $sum: { $cond: [{ $eq: ['$callType', 'missed'] }, 1, 0] },
        },
        incomingConnected: {
          $sum: {
            $cond: [{ $and: [{ $eq: ['$callType', 'incoming'] }, { $gt: ['$duration', 0] }] }, 1, 0],
          },
        },
        duplicateCalls: {
          $sum: { $cond: [{ $eq: ['$isDuplicate', true] }, 1, 0] },
        },
      },
    },
  ]);

  const summary = summaryAgg[0] || {
    totalCalls: 0,
    totalTalkTime: 0,
    connectedCalls: 0,
    cnpCalls: 0,
    missedCalls: 0,
    incomingConnected: 0,
    duplicateCalls: 0,
  };

  // 2. Staff Leaderboard Breakdown
  const staffLeaderboard = await CallLog.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$staffId',
        totalCalls: { $sum: 1 },
        totalTalkTime: { $sum: '$duration' },
        connectedCalls: {
          $sum: {
            $cond: [{ $and: [{ $eq: ['$callType', 'outgoing'] }, { $gt: ['$duration', 0] }] }, 1, 0],
          },
        },
        cnpCalls: {
          $sum: {
            $cond: [{ $and: [{ $eq: ['$callType', 'outgoing'] }, { $eq: ['$duration', 0] }] }, 1, 0],
          },
        },
        missedCalls: {
          $sum: { $cond: [{ $eq: ['$callType', 'missed'] }, 1, 0] },
        },
        lastCallAt: { $max: '$timestamp' },
      },
    },
    { $sort: { totalTalkTime: -1, totalCalls: -1 } },
  ]);

  // Populate staff details
  const populatedLeaderboard = await Promise.all(
    staffLeaderboard.map(async (row) => {
      const user = await User.findById(row._id).select('name employeeId departments avatar role').lean();
      const avgDuration = row.connectedCalls > 0 ? Math.round(row.totalTalkTime / row.connectedCalls) : 0;
      return {
        staffId: row._id,
        name: user?.name || 'Unknown',
        employeeId: user?.employeeId || 'N/A',
        departments: user?.departments || [],
        avatar: user?.avatar || null,
        totalCalls: row.totalCalls,
        totalTalkTime: row.totalTalkTime, // in seconds
        connectedCalls: row.connectedCalls,
        cnpCalls: row.cnpCalls,
        missedCalls: row.missedCalls,
        avgDuration, // in seconds
        lastCallAt: row.lastCallAt,
      };
    })
  );

  return { summary, leaderboard: populatedLeaderboard };
};

/**
 * Paginated Call Logs List
 */
export const getCallLogs = async ({ page = 1, limit = 50, staffId, department, callType, search, isDuplicate }) => {
  const query = {};

  if (staffId) query.staffId = staffId;
  if (department && department !== 'all') query.department = department;
  if (callType && callType !== 'all') query.callType = callType;
  if (isDuplicate !== undefined) query.isDuplicate = isDuplicate === 'true' || isDuplicate === true;

  if (search && search.trim()) {
    const clean = cleanPhone(search.trim());
    if (clean) {
      query.phoneNumber = new RegExp(clean, 'i');
    } else {
      query.leadName = new RegExp(search.trim(), 'i');
    }
  }

  const skip = (Math.max(1, parseInt(page, 10)) - 1) * parseInt(limit, 10);
  const total = await CallLog.countDocuments(query);
  const logs = await CallLog.find(query)
    .populate('staffId', 'name employeeId avatar departments')
    .populate('duplicateWithStaff.staffId', 'name employeeId')
    .sort({ timestamp: -1 })
    .skip(skip)
    .limit(parseInt(limit, 10))
    .lean();

  return { logs, total, page: parseInt(page, 10), pages: Math.ceil(total / limit) };
};

/**
 * Get Calling History for a specific lead or phone number
 */
export const getLeadCallingHistory = async (phone) => {
  const clean = cleanPhone(phone);
  if (!clean) return [];

  return CallLog.find({ phoneNumber: clean })
    .populate('staffId', 'name employeeId avatar')
    .sort({ timestamp: -1 })
    .limit(100)
    .lean();
};

/**
 * Get Pending Missed Calls
 */
export const getPendingMissedCalls = async ({ page = 1, limit = 30 }) => {
  const query = { callType: 'missed', status: 'missed_pending' };
  const skip = (Math.max(1, parseInt(page, 10)) - 1) * parseInt(limit, 10);
  const total = await CallLog.countDocuments(query);
  const logs = await CallLog.find(query)
    .populate('staffId', 'name employeeId')
    .sort({ timestamp: -1 })
    .skip(skip)
    .limit(parseInt(limit, 10))
    .lean();

  return { logs, total };
};

/**
 * Mark a Missed Call as resolved
 */
export const resolveMissedCall = async (logId, resolvedBy) => {
  return CallLog.findByIdAndUpdate(
    logId,
    {
      $set: {
        status: 'missed_resolved',
        resolvedAt: new Date(),
        resolvedBy,
      },
    },
    { new: true }
  );
};


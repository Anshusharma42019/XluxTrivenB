import catchAsync from '../../utils/catchAsync.js';
import ApiResponse from '../../utils/ApiResponse.js';
import smx from './shipmaxx.service.js';
import { ShipmaxxOrder as Order } from './models/shipmaxxOrder.model.js';
import { ShipmaxxFollowup as Followup } from './models/shipmaxxFollowup.model.js';
import { ShipmaxxDeliveredOrder as DeliveredOrder } from './models/shipmaxxDeliveredOrder.model.js';
import { ShipmaxxInTransitOrder as InTransitOrder } from './models/shipmaxxInTransitOrder.model.js';
import { ShipmaxxReadyToShipment as ReadyToShipment } from './models/shipmaxxReadyToShipment.model.js';
import { ShipmaxxRtoOrder as RTOOrder } from './models/shipmaxxRtoOrder.model.js';
import { ShipmaxxReturn as ShiprocketReturn } from './models/shipmaxxReturn.model.js';
import { Lead } from '../lead/lead.model.js';
import { User } from '../user/user.model.js';
import { NdrNote } from '../shiprocket/models/ndrNote.model.js';
import Task from '../task/task.model.js';
import Verification from '../verification/verification.model.js';
import { getNextOrderId } from '../shiprocket/counter/counter.model.js';
import { sendWhatsAppMessage } from '../interakt/interakt.service.js';
import * as leadService from '../lead/lead.service.js';
// ── Commission workflow: append-only chain + submitter lock ──────────────────
import { appendOrderChain } from '../commission/orderChain.service.js';

const DEFAULT_FOLLOWUP_TOTAL = 5;
const DEFAULT_FOLLOWUP_GAP_DAYS = 6;

// ── Shared ShipMaxx status normalization ─────────────────────────────────────
// ShipMaxx API returns short codes (DEL, INT, UND, etc.) — always normalize
// to full standard status names before storing in the database.
const SMX_STATUS_MAP = {
  ADI: 'REVERSE_PICKUP_FAILED',
  CTR: 'REVERSE_PICKUP_SCHEDULED',
  CUN: 'DISPOSED_OFF',
  DAC: 'REVERSE_PICKED_UP',
  DEL: 'DELIVERED',
  DEX: 'DELIVERY_EXCEPTION',
  DMG: 'DAMAGED',
  INT: 'IN_TRANSIT',
  LOS: 'LOST',
  OFD: 'OUT_FOR_DELIVERY',
  OFP: 'OUT_FOR_PICKUP',
  ONH: 'REVERSE_PICKUP_CANCELLED',
  PCN: 'PICKUP_CANCELLED',
  PKD: 'PICKUP_DONE',
  PKF: 'PICKUP_FAILED',
  RRA: 'RTO_INTRANSIT',
  RTD: 'RTO_DELIVERED',
  RTO: 'RTO_INITIATED',
  RUN: 'RTO_UNDELIVERED',
  SC: 'CANCELLED',
  SPB: 'SHIPMENT_BOOKED',
  SPD: 'PICKUP_SCHEDULED',
  UND: 'UNDELIVERED',
  NFI: 'NEW',
  NEW: 'NEW',
  CANCELED: 'CANCELLED',
  CANCELLED: 'CANCELLED',
  // All RTO in-transit variants → canonical RTO_INTRANSIT
  RTO_IN_TRANSIT: 'RTO_INTRANSIT',
  RTO_INT: 'RTO_INTRANSIT',
  'RTO-IT': 'RTO_INTRANSIT',
  RTO_IT: 'RTO_INTRANSIT',
  RTO_OFD: 'RTO_OFD',
  RAD: 'REACHED_AT_DESTINATION_HUB',
  RBS: 'REACHED_BACK_AT_SELLER_CITY',
  MIS: 'MISROUTED',
  UNDELIVERED_ATTEMPT_FAILURE: 'UNDELIVERED',
  UNDELIVERED_FAILURE: 'UNDELIVERED',
  // Direct status name mappings
  SHIPMENT_BOOKED: 'SHIPMENT_BOOKED',
  SHIPMENT_CANCELLED: 'CANCELLED'
};

export const normalizeShipmaxxStatus = (rawStatus) => {
  if (!rawStatus) return 'UNKNOWN';
  const s = String(rawStatus).trim().toUpperCase().replace(/[\s-]+/g, '_');
  return SMX_STATUS_MAP[s] || s;
};

const guessCourierByAwb = (awb) => {
  if (!awb) return '';
  const a = String(awb).trim().toUpperCase();
  if (a.startsWith('SF')) return 'Shadowfax';
  if (a.startsWith('770') || a.startsWith('778') || a.startsWith('42')) return 'Bluedart';
  if (a.startsWith('325')) return 'Delhivery';
  if (a.startsWith('152') || a.startsWith('13') || a.startsWith('14')) return 'XpressBees';
  if (a.startsWith('LON')) return 'Ekart';
  if (a.startsWith('DT')) return 'DTDC';
  return '';
};

// ── Order Department Detection ─────────────────────────────────────────────
const PILES_REGEX = /piles|gastro|bawasir|bavasir|hemorrhoid|fissure|fistula|bhagander/i;

export const detectOrderDepartment = (order) => {
  if (order?.department) return String(order.department).toLowerCase();
  const itemNames = (order?.order_items || []).map(i => i.name || '').join(' ');
  const itemSkus = (order?.order_items || []).map(i => i.sku || '').join(' ');
  const prob = order?.problem || '';
  const verifProb = order?.verification_problem || '';
  const notes = order?.notes || '';
  const text = `${itemNames} ${itemSkus} ${prob} ${verifProb} ${notes}`;
  if (PILES_REGEX.test(text)) return 'piles';
  return 'migraine';
};

// ── Round Robin Support Staff Assignment for Follow-ups ─────────────────────
export const getTodayActiveSupportUserIds = async (supportUserIds = []) => {
  try {
    const { default: Attendance } = await import('../attendance/attendance.model.js');
    const now = new Date();
    const IST_OFFSET = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(now.getTime() + IST_OFFSET);
    const todayUTC = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate()));

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    const query = {
      checkIn: { $ne: null },
      checkOut: null,
      isDeleted: false,
      $or: [
        { date: todayUTC },
        { date: { $gte: startOfDay, $lte: endOfDay } },
        { checkIn: { $gte: startOfDay } },
      ],
    };
    if (supportUserIds && supportUserIds.length > 0) {
      query.user = { $in: supportUserIds };
    }

    const activeAttendances = await Attendance.find(query).select('user').lean();
    return new Set(activeAttendances.map(a => String(a.user)));
  } catch (err) {
    return new Set();
  }
};

export const isDeptMatch = (userDepts, targetDept) => {
  if (!userDepts || !Array.isArray(userDepts) || userDepts.length === 0) return false;
  const normTarget = String(targetDept || 'migraine').toLowerCase().trim();
  const targetKey = normTarget.startsWith('migrain') ? 'migraine' : (normTarget.includes('pile') || normTarget.includes('gastro') || normTarget.includes('bawasir') ? 'piles' : normTarget);
  return userDepts.some(d => {
    const normD = String(d).toLowerCase().trim();
    const key = normD.startsWith('migrain') ? 'migraine' : (normD.includes('pile') || normD.includes('gastro') || normD.includes('bawasir') ? 'piles' : normD);
    return key === targetKey;
  });
};

export const isStaffEligibleForOrderDate = (user, orderDate) => {
  if (!user) return false;
  const accessDt = user.departmentAccessGrantedAt || user.joiningDate || user.createdAt;
  if (!accessDt) return true;
  const accessDay = new Date(accessDt);
  accessDay.setHours(0, 0, 0, 0); // Start of day when access was granted
  const ordDay = new Date(orderDate || Date.now());
  return ordDay >= accessDay;
};

export const getNextSupportUser = async (department = null, orderDate = null) => {
  const query = { role: 'support', isDeleted: { $ne: true } };
  let supportUsers = await User.find(query).sort({ createdAt: 1 });
  if (!supportUsers.length) return null;

  // Filter support users matching the required department (Must have explicit access!)
  const dept = department || 'migraine';
  let matchingUsers = supportUsers.filter(u => isDeptMatch(u.departments, dept));
  if (orderDate) {
    const dateMatching = matchingUsers.filter(u => isStaffEligibleForOrderDate(u, orderDate));
    if (dateMatching.length > 0) matchingUsers = dateMatching;
  }
  if (!matchingUsers.length) return null;
  supportUsers = matchingUsers;

  // Attendance check for today: only assign to staff who checked in and are present today
  const activeUserIds = await getTodayActiveSupportUserIds(supportUsers.map(u => u._id));
  const checkedInSupport = supportUsers.filter(u => activeUserIds.has(String(u._id)));
  const eligibleUsers = checkedInSupport.length > 0 ? checkedInSupport : supportUsers;

  // Pick user with oldest lastFollowupAssignedAt
  let selectedUser = eligibleUsers[0];
  for (let i = 1; i < eligibleUsers.length; i++) {
    const u = eligibleUsers[i];
    const selectedTime = selectedUser.lastFollowupAssignedAt ? new Date(selectedUser.lastFollowupAssignedAt).getTime() : -Infinity;
    const uTime = u.lastFollowupAssignedAt ? new Date(u.lastFollowupAssignedAt).getTime() : -Infinity;
    if (uTime < selectedTime) {
      selectedUser = u;
    }
  }

  await User.findByIdAndUpdate(selectedUser._id, { lastFollowupAssignedAt: new Date() }).catch(() => {});
  return selectedUser._id;
};

export const distributeUnassignedFollowupsEqually = async () => {
  const supportUsers = await User.find({ role: 'support', isDeleted: { $ne: true } })
    .select('_id name departments departmentAccessGrantedAt joiningDate createdAt lastFollowupAssignedAt')
    .sort({ createdAt: 1 })
    .lean();
  if (!supportUsers.length) return { distributed: 0 };

  const activeCheckedInUserIds = await getTodayActiveSupportUserIds(supportUsers.map(u => u._id));
  const checkedInUsers = supportUsers.filter(u => activeCheckedInUserIds.has(String(u._id)));

  // Partition staff strictly by assigned departments (No department access = No assignment)
  const pilesStaffAll = supportUsers.filter(u => isDeptMatch(u.departments, 'piles'));
  const migraineStaffAll = supportUsers.filter(u => isDeptMatch(u.departments, 'migraine'));

  const pilesStaffCheckedIn = checkedInUsers.filter(u => isDeptMatch(u.departments, 'piles'));
  const migraineStaffCheckedIn = checkedInUsers.filter(u => isDeptMatch(u.departments, 'migraine'));

  const deliveredOrders = await Order.find({
    platform: 'shipmaxx',
    status: { $in: ['DELIVERED', 'delivered', 'DEL', 'del'] },
    followup_done: { $ne: true },
    sent_to_verification: { $ne: true },
  }).select('_id support_staff order_items problem notes department delivered_at status_updated_at createdAt').lean();

  if (!deliveredOrders.length) return { distributed: 0 };

  const userMap = {};
  for (const u of supportUsers) {
    userMap[String(u._id)] = u;
  }

  let pilesIdx = 0;
  let migraineIdx = 0;
  const orderStaffMap = {};
  const orderIdsToReassign = [];

  for (const o of deliveredOrders) {
    const dept = detectOrderDepartment(o);
    const orderDate = o.delivered_at || o.status_updated_at || o.createdAt;
    const assignedId = o.support_staff ? String(o.support_staff) : null;
    const currentStaff = assignedId ? userMap[assignedId] : null;

    // Check department match & access date (Order date >= Staff access granted date)
    const isDeptValid = assignedId && currentStaff && isDeptMatch(currentStaff.departments, dept);
    const isDateValid = assignedId && currentStaff && isStaffEligibleForOrderDate(currentStaff, orderDate);

    // If there are checked-in staff for this department today, ensure the assigned staff is also present/checked-in today
    const eligiblePresentStaff = dept === 'piles' ? pilesStaffCheckedIn : migraineStaffCheckedIn;
    const isAttendanceValid = eligiblePresentStaff.length === 0 || (assignedId && activeCheckedInUserIds.has(assignedId));

    const isCurrentAssignmentValid = isDeptValid && isDateValid && isAttendanceValid;

    if (!isCurrentAssignmentValid) {
      // Find staff matching department and eligible for this order date
      const poolCheckedIn = dept === 'piles' ? pilesStaffCheckedIn : migraineStaffCheckedIn;
      const poolAll = dept === 'piles' ? pilesStaffAll : migraineStaffAll;
      
      const dateFilteredCheckedIn = poolCheckedIn.filter(u => isStaffEligibleForOrderDate(u, orderDate));
      const dateFilteredAll = poolAll.filter(u => isStaffEligibleForOrderDate(u, orderDate));

      const eligibleStaff = dateFilteredCheckedIn.length > 0 ? dateFilteredCheckedIn : (dateFilteredAll.length > 0 ? dateFilteredAll : (poolCheckedIn.length > 0 ? poolCheckedIn : poolAll));

      if (eligibleStaff.length > 0) {
        const selected = dept === 'piles'
          ? eligibleStaff[(pilesIdx++) % eligibleStaff.length]
          : eligibleStaff[(migraineIdx++) % eligibleStaff.length];

        orderStaffMap[String(o._id)] = selected._id;
        orderIdsToReassign.push(String(o._id));
      }
    }
  }

  if (orderIdsToReassign.length > 0) {
    const orderBulkOps = orderIdsToReassign.map(oid => ({
      updateOne: {
        filter: { _id: oid },
        update: { $set: { support_staff: orderStaffMap[oid] } }
      }
    }));
    await Order.bulkWrite(orderBulkOps);

    const fuBulkOps = orderIdsToReassign.map(oid => ({
      updateMany: {
        filter: { order_id: oid },
        update: { $set: { staff: orderStaffMap[oid] } }
      }
    }));
    await Followup.bulkWrite(fuBulkOps);
  }

  return { distributed: orderIdsToReassign.length, supportStaffCount: supportUsers.length, activeCheckedInCount: checkedInUsers.length };
};

export const autoAdvanceMissedFollowups = async () => {
  try {
    const now = new Date();
    // Find all incomplete followups
    const incompleteFUs = await Followup.find({ completed: { $ne: true } })
      .sort({ order_id: 1, followup_number: 1 })
      .lean();

    if (!incompleteFUs.length) return { advanced: 0, completedOrders: 0 };

    const orderFUMap = {};
    for (const fu of incompleteFUs) {
      const oid = String(fu.order_id);
      if (!orderFUMap[oid]) orderFUMap[oid] = [];
      orderFUMap[oid].push(fu);
    }

    const fuOps = [];
    const orderDoneIds = [];

    for (const [oid, fus] of Object.entries(orderFUMap)) {
      for (const fu of fus) {
        const k = fu.followup_number;
        const schedTime = new Date(fu.scheduled_date).getTime();
        const nextStageTime = schedTime + (DEFAULT_FOLLOWUP_GAP_DAYS * 86400000);

        // If current time has reached or passed the start of the next cycle (6 days after scheduled date)
        if (now.getTime() >= nextStageTime) {
          fuOps.push({
            updateOne: {
              filter: { _id: fu._id, completed: { $ne: true } },
              update: {
                $set: {
                  completed: true,
                  completed_at: new Date(schedTime),
                  status: 'auto_advanced',
                  notes: fu.notes ? fu.notes : 'Auto-advanced (Missed stage)'
                }
              }
            }
          });

          if (k >= DEFAULT_FOLLOWUP_TOTAL) {
            orderDoneIds.push(oid);
          }
        }
      }
    }

    if (fuOps.length > 0) {
      await Followup.bulkWrite(fuOps);
    }

    if (orderDoneIds.length > 0) {
      await Order.updateMany(
        { _id: { $in: orderDoneIds } },
        { $set: { followup_done: true, all_followups_done: true } }
      );
    }

    return { advanced: fuOps.length, completedOrders: orderDoneIds.length };
  } catch (err) {
    console.error('[ShipMaxx autoAdvanceMissedFollowups Error]:', err.message);
    return { error: err.message };
  }
};

export const setAutoFollowUps = async (orderId, deliveredAt, existingStaffId = null) => {
  const total = DEFAULT_FOLLOWUP_TOTAL;
  const gap = DEFAULT_FOLLOWUP_GAP_DAYS;
  const base = new Date(deliveredAt);
  const templateName = process.env.INTERAKT_1ST_FOLLOWUP_TEMPLATE;

  let staffId = existingStaffId;
  if (!staffId) {
    const orderDoc = await Order.findById(orderId).select('lead_id created_by support_staff staff').lean();
    if (orderDoc?.support_staff || orderDoc?.staff) {
      staffId = orderDoc.support_staff || orderDoc.staff;
    } else {
      staffId = await getNextSupportUser();
    }
  }

  const ops = Array.from({ length: total }, (_, i) => {
    const scheduled_date = new Date(base);
    scheduled_date.setDate(scheduled_date.getDate() + (i * gap)); // 1st call on day 0, 2nd on day 6, etc.
    const insertDoc = { 
      order_id: orderId, 
      followup_number: i + 1, 
      scheduled_date, 
      status: 'scheduled', 
      completed: false,
      staff: staffId || undefined
    };
    // Mark 1st followup as already messaged so cron doesn't send again
    if (i === 0 && templateName) insertDoc.auto_message_sent = true;
    return {
      updateOne: {
        filter: { order_id: orderId, followup_number: i + 1 },
        update: { 
          $setOnInsert: insertDoc,
          ...(staffId ? { $set: { staff: staffId } } : {})
        },
        upsert: true,
      },
    };
  });

  const bulkResult = await Followup.bulkWrite(ops);
  await Order.findByIdAndUpdate(orderId, { 
    auto_followups_set: true,
    ...(staffId ? { support_staff: staffId } : {})
  });

  // Only send WA if the 1st followup was actually newly inserted (not pre-existing)
  const was1stInserted = bulkResult.upsertedIds && bulkResult.upsertedIds[0] !== undefined;
  if (templateName && was1stInserted) {
    try {
      const order = await Order.findById(orderId).select('billing_phone billing_customer_name').lean();
      if (order && order.billing_phone) {
        sendWhatsAppMessage({
          phone: order.billing_phone,
          templateName,
          languageCode: 'en',
          bodyValues: [order.billing_customer_name || 'Customer']
        }).catch(async (err) => {
          console.error('[ShipMaxx] Real-time 1st followup WA error:', err.message);
          await Followup.updateOne(
            { order_id: orderId, followup_number: 1 },
            { $set: { auto_message_sent: false } }
          ).catch(() => { });
        });
        console.log(`[ShipMaxx] 1st followup WA message sent to ${order.billing_phone}`);
      }
    } catch (err) {
      console.error('[ShipMaxx] setAutoFollowUps WA send error:', err.message);
    }
  }
};

// Helper to safely parse ShipMaxx timestamps which might be in DD-MM-YYYY HH:mm:ss format
export const parseShipMaxxDate = (dateStr) => {
  if (!dateStr) return new Date();
  const parts = String(dateStr).trim().match(/^(\d{2})-(\d{2})-(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (parts) {
    // Let's use Date.parse to safely fallback if needed, but since it's tricky, we'll try to swap them if month > 12.
    let [_, p1, p2, y, h, min, s] = parts;
    let m = p2, d = p1;
    if (Number(p1) <= 12 && Number(p2) > 12) { m = p1; d = p2; } // format was MM-DD-YYYY
    else if (Number(p1) > 12 && Number(p2) <= 12) { d = p1; m = p2; } // format was DD-MM-YYYY
    // Construct local IST datetime
    return new Date(`${y}-${m}-${d}T${h || '00'}:${min || '00'}:${s || '00'}+05:30`);
  }
  return new Date(dateStr);
};

export const extractStatusUpdatedAt = (tracking, currentNormalizedStatus) => {
  let actualUpdatedAt = new Date();
  if (tracking && tracking.history && Array.isArray(tracking.history) && tracking.history.length > 0) {
    const sortedHistory = [...tracking.history].sort((a, b) => {
      const d1 = parseShipMaxxDate(a.date || a.timestamp || a.time).getTime();
      const d2 = parseShipMaxxDate(b.date || b.timestamp || b.time).getTime();
      return isNaN(d1) || isNaN(d2) ? 0 : d2 - d1; // newest first
    });
    let oldestConsecutiveDateStr = null;
    const baseStatus = String(currentNormalizedStatus).replace(/_1ST_ATTEMPT|_2ND_ATTEMPT|_3RD_ATTEMPT|_ATTEMPT_FAILURE|_FAILURE/i, '');
    for (let i = 0; i < sortedHistory.length; i++) {
      const h = sortedHistory[i];
      const hRawStatus = h.system_status_code || h.status || h.shipment_status || h.delivery_status;
      if (hRawStatus) {
        let hStatus = normalizeShipmaxxStatus(hRawStatus);
        if (hStatus === 'UNDELIVERED_ATTEMPT_FAILURE') hStatus = 'UNDELIVERED';
        const compareBase = baseStatus === 'UNDELIVERED_ATTEMPT_FAILURE' ? 'UNDELIVERED' : baseStatus;
        if (hStatus === compareBase) {
          oldestConsecutiveDateStr = h.date || h.timestamp || h.time;
        } else {
          break; // status changed, stop looking back
        }
      }
    }
    const dateStr = oldestConsecutiveDateStr || sortedHistory[0].date || sortedHistory[0].timestamp || sortedHistory[0].time;
    if (dateStr) {
      const parsedDate = parseShipMaxxDate(dateStr);
      if (parsedDate && !isNaN(parsedDate.getTime())) {
        actualUpdatedAt = parsedDate;
      }
    }
  }
  return actualUpdatedAt;
};


// ── Auth ──────────────────────────────────────────────────────────────────────
export const login = catchAsync(async (req, res) => {
  const { email, password, api_key, base_url } = req.body;
  if (base_url) smx.setAuthUrl(base_url);
  if (api_key) smx.setApiKey(api_key);
  if (email && password) smx.setCredentials(email, password);

  const token = await smx.login();
  res.json(new ApiResponse(200, { token }, 'ShipMaxx login successful'));
});

export const setPassword = catchAsync(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.json(new ApiResponse(400, null, 'email and password are required'));
  smx.setCredentials(email, password);
  res.json(new ApiResponse(200, null, 'ShipMaxx credentials updated successfully'));
});

// ── Orders ────────────────────────────────────────────────────────────────────
export const getOrder = catchAsync(async (req, res) => {
  const { order_id } = req.params;

  // Try local DB first (frontend passes MongoDB _id)
  const localOrder = await Order.findOne({
    platform: 'shipmaxx',
    $or: [{ _id: order_id.match(/^[a-f\d]{24}$/i) ? order_id : null }, { order_id: order_id }],
  })
    .populate({ path: 'lead_id', select: 'assignedTo createdBy status problem note', populate: [{ path: 'assignedTo', select: 'name role' }, { path: 'createdBy', select: 'name role' }] })
    .populate('created_by', 'name role')
    .populate('comments.createdBy', 'name role')
    .lean();

  if (localOrder) {
    const followups = await Followup.find({ order_id: localOrder._id }).sort({ followup_number: 1 }).lean();
    return res.json(new ApiResponse(200, { ...localOrder, followups }, 'Order fetched'));
  }

  // Fallback: fetch from ShipMaxx external API (only for numeric order IDs)
  const data = await smx.getOrder(order_id);
  res.json(new ApiResponse(200, data, 'Order fetched'));
});

export const createOrder = catchAsync(async (req, res) => {
  const { pickup_address_id, channel_id, payment_method, order_number, customer, products, package: pkg, billing_address, other_charges, total_discount } = req.body;

  const required = ['pickup_address_id', 'channel_id', 'payment_method', 'order_number', 'customer', 'products', 'package'];
  const missing = required.filter((k) => !req.body[k]);
  if (missing.length) return res.json(new ApiResponse(400, null, `Missing: ${missing.join(', ')}`));

  const customerRequired = ['phone', 'name', 'address', 'pincode', 'city', 'state'];
  const missingCustomer = customerRequired.filter((k) => !customer[k]);
  if (missingCustomer.length) return res.json(new ApiResponse(400, null, `Missing customer fields: ${missingCustomer.join(', ')}`));

  const fresh_order_id = await getNextOrderId();

  const payload = {
    pickup_address_id: Number(pickup_address_id),
    channel_id: Number(channel_id),
    payment_method,
    order_number: fresh_order_id,
    customer,
    products: (products || []).map(p => ({
      sku: String(p.sku || ''),
      name: String(p.name || ''),
      price: Number(p.price) || 0,
      quantity: Number(p.quantity) || 1,
    })),
    package: {
      weight: Number(pkg.weight) || 0.5,
      length: Number(pkg.length) || 10,
      width: Number(pkg.width) || 10,
      height: Number(pkg.height) || 10,
    },
    ...(billing_address && { billing_address }),
    ...(other_charges !== undefined && { other_charges: Number(other_charges) || 0 }),
    ...(total_discount !== undefined && { total_discount: Number(total_discount) || 0 }),
  };

  const data = await smx.createOrder(payload);
  const smxRes = data?.data || data || {};
  const oid = smxRes.order_id || smxRes.id || order_number;

  // Log in CRM Order database
  try {
    let matchedLeadId = req.body.lead_id || null;
    if (!matchedLeadId && customer && customer.phone) {
      const cleanPhone = String(customer.phone).replace(/\D/g, '');
      if (cleanPhone.length >= 10) {
        const lead = await leadService.findLeadByPhone(cleanPhone);
        if (lead) matchedLeadId = lead._id;
      }
    }

    const subTotal = (products || []).reduce((sum, p) => sum + (Number(p.price) * (Number(p.quantity) || 1)), 0) + (Number(other_charges) || 0) - (Number(total_discount) || 0);
    // Find verified_by and verification_id from Verification record for this lead
    let verifiedBy = req.user?._id;
    let verificationId = null;
    let taskCreatedBy = null;
    if (matchedLeadId) {
      const verDoc = await Verification.findOne({ lead: matchedLeadId, isDeleted: { $ne: true } }).populate('task', 'createdBy').sort({ createdAt: -1 }).lean();
      if (verDoc) {
        verifiedBy = verDoc.verifiedBy || verDoc.assignedTo || req.user?._id;
        verificationId = verDoc._id; // Lock verification_id on order permanently
        taskCreatedBy = verDoc.task?.createdBy || null;
      }
    }

    const savedOrder = await Order.create({
      order_id: String(oid),
      status: 'NEW',
      billing_customer_name: customer.name,
      billing_phone: customer.phone,
      billing_address: customer.address,
      billing_city: customer.city,
      billing_state: customer.state,
      billing_pincode: customer.pincode,
      billing_email: customer.email || '',
      payment_method: payment_method,
      sub_total: subTotal,
      order_items: (products || []).map(p => ({ name: p.name, sku: p.sku, units: p.quantity, selling_price: p.price })),
      platform: 'shipmaxx',
      created_by: req.user?._id,
      verified_by: verifiedBy,
      verification_id: verificationId, // Permanently links order to the Closer's verification record
      task_created_by: taskCreatedBy,
      lead_id: matchedLeadId,
      raw_response: smxRes,
    });

    // If this lead had a pending re-order source (from follow-up cycle), link it and clear the flag
    if (matchedLeadId && savedOrder) {
      const lead = await Lead.findById(matchedLeadId).select('pending_reorder_source pending_reorder_staff').lean();
      if (lead?.pending_reorder_source) {
        await Order.findByIdAndUpdate(savedOrder._id, {
          source_order_id: lead.pending_reorder_source,
          verified_by: lead.pending_reorder_staff || req.user?._id,
        });
        await Lead.findByIdAndUpdate(matchedLeadId, { $unset: { pending_reorder_source: 1, pending_reorder_staff: 1 } });
      }
    }
  } catch (err) {
    console.error('[ShipMaxx Create Order Log Error]', err.message);
  }

  res.json(new ApiResponse(200, { ...data, extracted_order_id: oid }, 'Order created'));
});

export const createOrderAndShipment = catchAsync(async (req, res) => {
  const { pickup_address_id, channel_id, payment_method, order_number, customer, products, package: pkg, billing_address, other_charges, total_discount, warehouse_id, carrier_variant_id } = req.body;

  const required = ['pickup_address_id', 'channel_id', 'payment_method', 'order_number', 'customer', 'products', 'package'];
  const missing = required.filter((k) => !req.body[k]);
  if (missing.length) return res.json(new ApiResponse(400, null, `Missing: ${missing.join(', ')}`));

  const customerRequired = ['phone', 'name', 'address', 'pincode', 'city', 'state'];
  const missingCustomer = customerRequired.filter((k) => !customer[k]);
  if (missingCustomer.length) return res.json(new ApiResponse(400, null, `Missing customer fields: ${missingCustomer.join(', ')}`));

  const fresh_order_id = await getNextOrderId();

  const payload = {
    pickup_address_id: Number(pickup_address_id),
    channel_id: Number(channel_id),
    payment_method,
    order_number: fresh_order_id,
    customer,
    products: (products || []).map(p => ({
      sku: String(p.sku || ''),
      name: String(p.name || ''),
      price: Number(p.price) || 0,
      quantity: Number(p.quantity) || 1,
    })),
    package: {
      weight: Number(pkg.weight) || 0.5,
      length: Number(pkg.length) || 10,
      width: Number(pkg.width) || 10,
      height: Number(pkg.height) || 10,
    },
    ...(billing_address && { billing_address }),
    ...(other_charges !== undefined && { other_charges: Number(other_charges) || 0 }),
    ...(total_discount !== undefined && { total_discount: Number(total_discount) || 0 }),
  };

  const data = await smx.createOrder(payload);
  const smxRes = data?.data || data || {};
  const oid = smxRes.order_id || smxRes.id || order_number;

  // Log in CRM Order database
  try {
    let matchedLeadId = req.body.lead_id || null;
    if (!matchedLeadId && customer && customer.phone) {
      const cleanPhone = String(customer.phone).replace(/\D/g, '');
      if (cleanPhone.length >= 10) {
        const lead = await leadService.findLeadByPhone(cleanPhone);
        if (lead) matchedLeadId = lead._id;
      }
    }

    const subTotal = (products || []).reduce((sum, p) => sum + (Number(p.price) * (Number(p.quantity) || 1)), 0) + (Number(other_charges) || 0) - (Number(total_discount) || 0);
    // Find verified_by and verification_id from Verification record for this lead
    let verifiedBy = req.user?._id;
    let verificationId = null;
    let taskCreatedBy = null;
    if (matchedLeadId) {
      const verDoc = await Verification.findOne({ lead: matchedLeadId, isDeleted: { $ne: true } }).populate('task', 'createdBy').sort({ createdAt: -1 }).lean();
      if (verDoc) {
        verifiedBy = verDoc.verifiedBy || verDoc.assignedTo || req.user?._id;
        verificationId = verDoc._id; // Lock verification_id on order permanently
        taskCreatedBy = verDoc.task?.createdBy || null;
      }
    }

    const savedOrder = await Order.create({
      order_id: String(oid),
      status: 'NEW',
      billing_customer_name: customer.name,
      billing_phone: customer.phone,
      billing_address: customer.address,
      billing_city: customer.city,
      billing_state: customer.state,
      billing_pincode: customer.pincode,
      billing_email: customer.email || '',
      payment_method: payment_method,
      sub_total: subTotal,
      order_items: (products || []).map(p => ({ name: p.name, sku: p.sku, units: p.quantity, selling_price: p.price })),
      platform: 'shipmaxx',
      created_by: req.user?._id,
      verified_by: verifiedBy,
      verification_id: verificationId, // Permanently links order to the Closer's verification record
      task_created_by: taskCreatedBy,
      lead_id: matchedLeadId,
      raw_response: smxRes,
    });

    // If this lead had a pending re-order source (from follow-up cycle), link it and clear the flag
    if (matchedLeadId && savedOrder) {
      const lead = await Lead.findById(matchedLeadId).select('pending_reorder_source pending_reorder_staff').lean();
      if (lead?.pending_reorder_source) {
        await Order.findByIdAndUpdate(savedOrder._id, {
          source_order_id: lead.pending_reorder_source,
          verified_by: lead.pending_reorder_staff || req.user?._id,
        });
        await Lead.findByIdAndUpdate(matchedLeadId, { $unset: { pending_reorder_source: 1, pending_reorder_staff: 1 } });
      }
    }
  } catch (err) {
    console.error('[ShipMaxx Create Order Log Error]', err.message);
  }

  // Step 2: Create Shipment
  let shipmentData = null;
  let awb = null;
  try {
    const shipmentPayload = {
      order_id: String(oid),
      ...(warehouse_id && { warehouse_id: Number(warehouse_id) }),
      ...(carrier_variant_id && { carrier_variant_id: Number(carrier_variant_id) }),
    };
    shipmentData = await smx.createShipment(shipmentPayload);
    const shipRes = shipmentData?.data || shipmentData || {};
    awb = shipRes.awb || shipRes.awb_number;

    if (awb) {
      await Order.updateWithTransaction(
        { order_id: String(oid), platform: 'shipmaxx' },
        { $set: { awb_code: awb, status: 'SHIPPED', status_updated_at: new Date() } }
      );
    }
  } catch (err) {
    console.error('[ShipMaxx Create Shipment Log Error]', err.message);
  }

  res.json(new ApiResponse(200, {
    order: { ...data, extracted_order_id: oid },
    shipment: shipmentData,
    awb_code: awb
  }, awb ? 'Order and Shipment created successfully' : 'Order created, but Shipment failed'));
});

export const updateOrder = catchAsync(async (req, res) => {
  const { order_id } = req.params;
  if (!order_id) return res.json(new ApiResponse(400, null, 'order_id is required'));
  const data = await smx.updateOrder(order_id, req.body);

  if (req.body.status) {
    try {
      await Order.updateWithTransaction(
        { order_id: String(order_id), platform: 'shipmaxx' },
        { $set: { status: String(req.body.status).toUpperCase(), status_updated_at: new Date() } }
      );
    } catch (err) {
      console.error('[ShipMaxx Update Order Status Log Error]', err.message);
    }
  }

  res.json(new ApiResponse(200, data, 'Order updated'));
});

// ── Shipping ──────────────────────────────────────────────────────────────────
export const createShipment = catchAsync(async (req, res) => {
  const { order_id, warehouse_id, carrier_variant_id } = req.body;
  if (!order_id) return res.json(new ApiResponse(400, null, 'order_id is required'));
  const payload = {
    order_id: String(order_id),
    ...(warehouse_id && { warehouse_id: Number(warehouse_id) }),
    ...(carrier_variant_id && { carrier_variant_id: Number(carrier_variant_id) }),
  };
  const data = await smx.createShipment(payload);
  const smxRes = data?.data || data || {};
  const awb = smxRes.awb || smxRes.awb_number;

  if (awb) {
    try {
      await Order.updateWithTransaction(
        { order_id: String(order_id), platform: 'shipmaxx' },
        { $set: { awb_code: awb, status: 'SHIPPED', status_updated_at: new Date() } }
      );
    } catch (err) {
      console.error('[ShipMaxx Create Shipment Log Error]', err.message);
    }
  }

  res.json(new ApiResponse(200, data, 'Shipment created'));
});

export const trackShipment = catchAsync(async (req, res) => {
  const awb = req.params.awb || req.query.awb;
  if (!awb) return res.json(new ApiResponse(400, null, 'awb is required'));
  const data = await smx.trackShipment(awb);
  res.json(new ApiResponse(200, data, 'Tracking info fetched'));
});

export const cancelShipment = catchAsync(async (req, res) => {
  const { awb, cancellation_reason } = req.body;
  if (!awb) return res.json(new ApiResponse(400, null, 'awb is required'));
  const data = await smx.cancelShipment(req.body);

  try {
    await Order.updateWithTransaction(
      { platform: 'shipmaxx', awb_code: awb },
      { $set: { status: 'CANCELLED', status_updated_at: new Date() } }
    );
  } catch (err) {
    console.error('[ShipMaxx Cancel Shipment Log Error]', err.message);
  }

  res.json(new ApiResponse(200, data, 'Shipment cancelled'));
});

export const checkServiceability = catchAsync(async (req, res) => {
  const { source_pincode, destination_pincode, weight_kg } = req.body;
  if (!source_pincode || !destination_pincode || !weight_kg)
    return res.json(new ApiResponse(400, null, 'source_pincode, destination_pincode, weight_kg are required'));
  const data = await smx.checkServiceability(req.body);
  res.json(new ApiResponse(200, data, 'Serviceability fetched'));
});

export const getShipments = catchAsync(async (req, res) => {
  const data = await smx.getShipments(req.query);
  res.json(new ApiResponse(200, data, 'Shipments fetched'));
});

export const getShipmentById = catchAsync(async (req, res) => {
  const { shipment_id } = req.params;
  if (!shipment_id) return res.json(new ApiResponse(400, null, 'shipment_id is required'));
  const data = await smx.getShipmentById(shipment_id);
  res.json(new ApiResponse(200, data, 'Shipment fetched'));
});

export const generateLabel = catchAsync(async (req, res) => {
  const awb = req.params.awb || req.query.awb;
  if (!awb) return res.json(new ApiResponse(400, null, 'awb is required'));

  const buffer = await smx.downloadLabelPdf(awb);

  if (!buffer || buffer.length === 0) {
    return res.status(400).json(new ApiResponse(400, null, 'Label not available yet (empty response)'));
  }

  const startStr = buffer.toString('utf8', 0, 20);
  if (!startStr.trim().startsWith('%PDF-')) {
    const fullText = buffer.toString('utf8');
    try {
      const json = JSON.parse(fullText);
      return res.status(400).json(new ApiResponse(400, null, json.message || 'Label not available yet'));
    } catch (e) {
      return res.status(400).json(new ApiResponse(400, null, 'Label not available yet (invalid format from ShipMaxx)'));
    }
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="label-${awb}.pdf"`);
  res.send(buffer);
});

export const getManifest = catchAsync(async (req, res) => {
  const awb = req.params.awb || req.query.awb;
  if (!awb) return res.json(new ApiResponse(400, null, 'awb is required'));

  const buffer = await smx.downloadManifestHtml(awb);
  if (!buffer || buffer.length === 0) {
    return res.status(400).json(new ApiResponse(400, null, 'Manifest not available yet (empty response)'));
  }

  const startStr = buffer.toString('utf8', 0, 20);
  if (!startStr.trim().startsWith('%PDF-')) {
    const fullText = buffer.toString('utf8');
    try {
      const json = JSON.parse(fullText);
      return res.status(400).json(new ApiResponse(400, null, json.message || 'Manifest not available yet'));
    } catch (e) {
      return res.status(400).json(new ApiResponse(400, null, 'Manifest not available yet (invalid format from ShipMaxx)'));
    }
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="manifest-${awb}.pdf"`);
  res.send(buffer);
});

// ── Warehouses ────────────────────────────────────────────────────────────────
export const getWarehouses = catchAsync(async (req, res) => {
  const data = await smx.getWarehouses(req.query);
  res.json(new ApiResponse(200, data, 'Warehouses fetched'));
});

export const createWarehouse = catchAsync(async (req, res) => {
  const { name, address, city, state, pincode } = req.body;
  if (!name || !address || !city || !state || !pincode)
    return res.json(new ApiResponse(400, null, 'name, address, city, state, pincode are required'));
  const data = await smx.createWarehouse(req.body);
  res.json(new ApiResponse(200, data, 'Warehouse created'));
});

// ── Invoice ───────────────────────────────────────────────────────────────────
export const getInvoice = catchAsync(async (req, res) => {
  const { order_id } = req.params;
  if (!order_id) return res.json(new ApiResponse(400, null, 'order_id is required'));
  const buffer = await smx.getInvoice(order_id);

  if (!buffer || buffer.length === 0) {
    return res.status(400).json(new ApiResponse(400, null, 'Invoice not available yet (empty response)'));
  }

  const startStr = buffer.toString('utf8', 0, 20);
  if (!startStr.trim().startsWith('%PDF-')) {
    const fullText = buffer.toString('utf8');
    try {
      const json = JSON.parse(fullText);
      return res.status(400).json(new ApiResponse(400, null, json.message || 'Invoice not available yet'));
    } catch (e) {
      return res.status(400).json(new ApiResponse(400, null, 'Invoice not available yet (invalid format from ShipMaxx)'));
    }
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="invoice-${order_id}.pdf"`);
  res.send(buffer);
});

// ── Debug: test raw ShipMaxx response ────────────────────────────────────────
export const debugSync = catchAsync(async (req, res) => {
  const ids = ['38565', '44241', '25590'];
  let results = [];
  for (const id of ids) {
    const o = await Order.findOne({ order_id: id });
    if (!o || !o.awb_code) continue;
    try {
      const trackRes = await smx.trackShipment(o.awb_code);
      const tracking = trackRes?.data?.data || trackRes?.data || trackRes || {};
      const history = tracking.history || tracking.tracking_history || [];
      let actualDate = null;
      if (Array.isArray(history) && history.length > 0) {
        const deliveredEvent = history.find(h => String(h.status || h.activity || '').toUpperCase().includes('DELIVERED'));
        const latest = deliveredEvent || history[0];
        const dateStr = latest.date || latest.timestamp || latest.time;
        if (dateStr) actualDate = parseShipMaxxDate(dateStr);
      }
      if (!actualDate) {
        // fallback to order creation date + 3 days or something
        actualDate = o.createdAt ? new Date(o.createdAt.getTime() + 3 * 86400000) : new Date('2026-06-28T12:00:00Z');
      }
      await Order.updateWithTransaction({ _id: o._id }, { $set: { delivered_at: actualDate, status_updated_at: actualDate } });
      results.push({ id, actualDate });
    } catch (e) {
      results.push({ id, error: e.message });
    }
  }
  res.json(new ApiResponse(200, results, 'Debug fix executed'));
});


// ── Status classification for date filtering ────────────────────────────────
// COMPLETED statuses → date-filter by delivered_at (when order finished)
// ATTEMPT statuses   → date-filter by status_updated_at (when attempt happened)
// PIPELINE statuses  → always show current count (no date filter — live state)
//
// Why this matters: OFD orders dispatched yesterday but not yet scanned again
// should still show as OFD today. Filtering by date would hide them.
const TERMINAL_STATUSES_RE = /^(delivered|rto_delivered|cancelled|canceled|DEL|RTD)$/i;

// Statuses that represent a discrete delivery ATTEMPT/EVENT event — date-filter these
const ATTEMPT_STATUSES_RE = /^(undelivered_1st_attempt|undelivered_2nd_attempt|undelivered_3rd_attempt|undelivered|undelivered_attempt_failure|undelivered_failure|pickup_failed|pickup_cancelled|delivery_exception)$/i;

// Pipeline/live statuses — always show current count regardless of date
// These represent WHERE orders ARE now, not WHAT happened on a specific day
const PIPELINE_STATUSES_RE = /^(new|pickup_scheduled|shipped|in_transit|rto_initiated|rto_in_transit|rto_intransit|rto_ofd|rto_undelivered|received_at_rts_hub|recd_at_dc_rts|rto_int|rto_it|rto-it|out_for_pickup|pickup_done|reached_at_destination_hub|reached_back_at_seller_city|misrouted|damaged|lost|shipment_booked|invoiced|spb|spd|int|ofp|pkd|rto|rra|run|out_for_delivery|ofd)$/i;

export const getDeliveredStats = catchAsync(async (req, res) => {
  const { from, to, department } = req.query;

  const baseConditions = [
    { platform: 'shipmaxx' }
  ];

  const PILES_REGEX = /piles|gastro|bawasir|bavasir|hemorrhoid|fissure|fistula|bhagander/i;

  if (department && department !== 'all') {
    if (department === 'piles') {
      baseConditions.push({
        $or: [
          { department: 'piles' },
          { 'order_items.name': PILES_REGEX },
          { 'order_items.sku': PILES_REGEX },
          { 'products.name': PILES_REGEX },
          { 'products.sku': PILES_REGEX },
          { product_name: PILES_REGEX },
          { problem: PILES_REGEX },
          { remarks: PILES_REGEX },
        ]
      });
    } else if (department === 'migraine') {
      baseConditions.push({
        $and: [
          { department: { $ne: 'piles' } },
          { 'order_items.name': { $not: PILES_REGEX } },
          { 'order_items.sku': { $not: PILES_REGEX } },
          { 'products.name': { $not: PILES_REGEX } },
          { 'products.sku': { $not: PILES_REGEX } },
          { product_name: { $not: PILES_REGEX } },
          { problem: { $not: PILES_REGEX } },
          { remarks: { $not: PILES_REGEX } },
        ]
      });
    }
  }

  if (from && to) {
    const dateFilter = {
      $gte: new Date(from + 'T00:00:00.000+05:30'),
      $lte: new Date(to + 'T23:59:59.999+05:30'),
    };
    baseConditions.push({
      $or: [
        // ── DELIVERED: filter by delivered_at, fallback to status_updated_at, then createdAt ──
        { status: /^delivered$/i, delivered_at: dateFilter },
        { status: /^delivered$/i, $or: [{ delivered_at: { $exists: false } }, { delivered_at: null }], status_updated_at: dateFilter },
        { status: /^delivered$/i, $or: [{ delivered_at: { $exists: false } }, { delivered_at: null }], $and: [{ $or: [{ status_updated_at: { $exists: false } }, { status_updated_at: null }] }], createdAt: dateFilter },
        // RTO_DELIVERED: same logic
        { status: /^rto_delivered$/i, delivered_at: dateFilter },
        { status: /^rto_delivered$/i, $or: [{ delivered_at: { $exists: false } }, { delivered_at: null }], status_updated_at: dateFilter },
        // Short codes (DEL, RTD)
        { status: /^DEL$/i, delivered_at: dateFilter },
        { status: /^DEL$/i, $or: [{ delivered_at: { $exists: false } }, { delivered_at: null }], status_updated_at: dateFilter },
        { status: /^RTD$/i, delivered_at: dateFilter },
        { status: /^RTD$/i, $or: [{ delivered_at: { $exists: false } }, { delivered_at: null }], status_updated_at: dateFilter },
        // ── CANCELLED: filter by status_updated_at or createdAt ───────────────
        { status: /^cancell?ed$/i, status_updated_at: dateFilter },
        { status: /^cancell?ed$/i, status_updated_at: { $exists: false }, createdAt: dateFilter },
        { status: /^cancell?ed$/i, status_updated_at: null, createdAt: dateFilter },
        // ── ATTEMPT statuses: filter by when the attempt happened ─────────────
        // Shows only today's failed delivery attempts / pickup failures
        { status: ATTEMPT_STATUSES_RE, status_updated_at: dateFilter },
        { status: ATTEMPT_STATUSES_RE, $or: [{ status_updated_at: { $exists: false } }, { status_updated_at: null }], createdAt: dateFilter },
        // ── PIPELINE statuses: show live current count for recent shipments (last 38 days)
        // Older shipments are no longer tracked by the cron and may have stale statuses.
        { status: PIPELINE_STATUSES_RE, createdAt: { $gte: new Date(Date.now() - 38 * 24 * 60 * 60 * 1000) } },
      ]
    });
  }

  const match = { $and: baseConditions };

  // Build a clean DELIVERED-only date query (independent of the main match $or)
  // Fallback: if delivered_at is null/missing, use status_updated_at, then createdAt
  const statusFilter = { $in: [/^delivered$/i, /^DEL$/i] };
  let deliveredOnlyMatch;
  if (from && to) {
    const dateFilter = { $gte: new Date(from + 'T00:00:00.000+05:30'), $lte: new Date(to + 'T23:59:59.999+05:30') };
    deliveredOnlyMatch = {
      platform: 'shipmaxx',
      $and: [
        { status: statusFilter },
        {
          $or: [
            { delivered_at: dateFilter },
            { $and: [{ $or: [{ delivered_at: { $exists: false } }, { delivered_at: null }] }, { status_updated_at: dateFilter }] },
            { $and: [{ $or: [{ delivered_at: { $exists: false } }, { delivered_at: null }] }, { $or: [{ status_updated_at: { $exists: false } }, { status_updated_at: null }] }, { createdAt: dateFilter }] },
          ]
        }
      ]
    };
  } else {
    deliveredOnlyMatch = {
      platform: 'shipmaxx',
      status: statusFilter
    };
  }

  const [deliveredCountResult, statusBreakdown, revenueAggregation, paymentBreakdownResult] = await Promise.all([
    Order.countDocuments(deliveredOnlyMatch),
    Order.aggregate([
      { $match: match },
      { $group: { _id: '$status', count: { $sum: 1 }, revenue: { $sum: '$sub_total' } } },
      { $sort: { count: -1 } }
    ]),
    Order.aggregate([
      { $match: deliveredOnlyMatch },
      { $group: { _id: null, totalRevenue: { $sum: '$sub_total' } } }
    ]),
    Order.aggregate([
      { $match: deliveredOnlyMatch },
      {
        $group: {
          _id: {
            $cond: [
              { $regexMatch: { input: { $ifNull: ['$payment_method', 'COD'] }, regex: /cod/i } },
              'COD',
              'Prepaid'
            ]
          },
          count: { $sum: 1 },
          revenue: { $sum: '$sub_total' }
        }
      }
    ])
  ]);

  let codCount = 0;
  let codRevenue = 0;
  let prepaidCount = 0;
  let prepaidRevenue = 0;
  for (const item of (paymentBreakdownResult || [])) {
    if (item._id === 'COD') {
      codCount = item.count;
      codRevenue = item.revenue || 0;
    } else {
      prepaidCount = item.count;
      prepaidRevenue = item.revenue || 0;
    }
  }

  // Post-process: merge any remaining short-code groups into their full-name equivalents
  const mergedMap = {};
  for (const item of statusBreakdown) {
    let normalizedId = normalizeShipmaxxStatus(item._id);

    // Group only raw RTO / RTO_INITIATED / RUN (failed RTO attempt) under RTO_INITIATED
    const intermediateRTO = ['RTO_INITIATED', 'RTO', 'RUN', 'RTO_UNDELIVERED'];
    if (intermediateRTO.includes(normalizedId)) {
      normalizedId = 'RTO_INITIATED';
    }

    if (!mergedMap[normalizedId]) {
      mergedMap[normalizedId] = { _id: normalizedId, count: 0, revenue: 0 };
    }
    mergedMap[normalizedId].count += item.count;
    mergedMap[normalizedId].revenue += (item.revenue || 0);
  }
  const breakdown = Object.values(mergedMap).sort((a, b) => b.count - a.count);

  const delIdx = breakdown.findIndex(b => /^delivered$/i.test(b._id));
  if (delIdx === -1) {
    breakdown.unshift({ _id: 'DELIVERED', count: deliveredCountResult, revenue: 0 });
  } else {
    breakdown[delIdx].count = deliveredCountResult;
  }

  const totalRevenue = revenueAggregation?.[0]?.totalRevenue || 0;

  res.json(new ApiResponse(200, {
    count: deliveredCountResult,
    revenue: totalRevenue,
    codCount,
    codRevenue,
    prepaidCount,
    prepaidRevenue,
    statusBreakdown: breakdown
  }, 'Delivered stats'));
});

// Known DB spelling aliases: some statuses were stored with alternate spellings
// This ensures clicking a card queries ALL variants stored in the DB.
const STATUS_ALIASES = {
  RTO_INTRANSIT: ['RTO_INTRANSIT', 'RTO_IN_TRANSIT', 'RTO_INT', 'RTO-IT', 'RTO_IT', 'RRA'],
  RTO_IN_TRANSIT: ['RTO_INTRANSIT', 'RTO_IN_TRANSIT', 'RTO_INT', 'RTO-IT', 'RTO_IT', 'RRA'],
  NEW: ['NEW', 'NFI', 'SPB'],
  UNDELIVERED: ['UNDELIVERED', 'UND', 'UNDELIVERED_ATTEMPT_FAILURE', 'UNDELIVERED_FAILURE', 'UNDELIVERED_1ST_ATTEMPT', 'UNDELIVERED_2ND_ATTEMPT', 'UNDELIVERED_3RD_ATTEMPT', 'UNDELIVERED-1ST_ATTEMPT', 'UNDELIVERED-2ND_ATTEMPT', 'UNDELIVERED-3RD_ATTEMPT', 'DELIVERY_EXCEPTION', 'DEX'],
  CANCELLED: ['CANCELLED', 'CANCELED', 'SC'],
  DELIVERED: ['DELIVERED', 'DEL'],
  RTO_DELIVERED: ['RTO_DELIVERED', 'RTD'],
  IN_TRANSIT: ['IN_TRANSIT', 'INT'],
  OUT_FOR_DELIVERY: ['OUT_FOR_DELIVERY', 'OFD', 'OUT FOR DELIVERY', 'OUT-FOR-DELIVERY'],
  OUT_FOR_PICKUP: ['OUT_FOR_PICKUP', 'OFP'],
  PICKUP_DONE: ['PICKUP_DONE', 'PKD'],
  PICKUP_FAILED: ['PICKUP_FAILED', 'PKF'],
  PICKUP_CANCELLED: ['PICKUP_CANCELLED', 'PCN'],
  PICKUP_SCHEDULED: ['PICKUP_SCHEDULED', 'SPD'],
  DELIVERY_EXCEPTION: ['DELIVERY_EXCEPTION', 'DEX'],
  DAMAGED: ['DAMAGED', 'DMG'],
  LOST: ['LOST', 'LOS'],
  RTO_INITIATED: ['RTO_INITIATED', 'RTO', 'RTO_INTRANSIT', 'RTO_IN_TRANSIT', 'RTO_INT', 'RTO-IT', 'RTO_IT', 'RRA', 'RTO_OFD', 'RTO_UNDELIVERED', 'RUN', 'RECEIVED_AT_RTS_HUB', 'RECD_AT_DC_RTS', 'REACHED_BACK_AT_SELLER_CITY'],
  RTO_UNDELIVERED: ['RTO_UNDELIVERED', 'RUN'],
  SHIPMENT_BOOKED: ['SHIPMENT_BOOKED', 'SPB'],
  DISPOSED_OFF: ['DISPOSED_OFF', 'CUN'],
  REVERSE_PICKUP_FAILED: ['REVERSE_PICKUP_FAILED', 'ADI'],
  REVERSE_PICKUP_SCHEDULED: ['REVERSE_PICKUP_SCHEDULED', 'CTR'],
  REVERSE_PICKED_UP: ['REVERSE_PICKED_UP', 'DAC'],
  REVERSE_PICKUP_CANCELLED: ['REVERSE_PICKUP_CANCELLED', 'ONH'],
  REACHED_AT_DESTINATION_HUB: ['REACHED_AT_DESTINATION_HUB', 'RAD'],
  REACHED_BACK_AT_SELLER_CITY: ['REACHED_BACK_AT_SELLER_CITY', 'RBS'],
  MISROUTED: ['MISROUTED', 'MIS'],
};

export const getStatusOrders = catchAsync(async (req, res) => {
  const { status, shipment_status, from, to, department, limit = 50 } = req.query;

  const queryStatus = shipment_status ?
    (SMX_STATUS_MAP[String(shipment_status).trim().toUpperCase()] || String(shipment_status).trim().toUpperCase())
    : status;

  if (!queryStatus) return res.status(400).json(new ApiResponse(400, null, 'Status is required'));

  const baseConditions = [
    { platform: 'shipmaxx' }
  ];

  const PILES_REGEX = /piles|gastro|bawasir|bavasir|hemorrhoid|fissure|fistula|bhagander/i;

  if (department && department !== 'all') {
    if (department === 'piles') {
      baseConditions.push({
        $or: [
          { department: 'piles' },
          { 'order_items.name': PILES_REGEX },
          { 'order_items.sku': PILES_REGEX },
          { 'products.name': PILES_REGEX },
          { 'products.sku': PILES_REGEX },
          { product_name: PILES_REGEX },
          { problem: PILES_REGEX },
          { remarks: PILES_REGEX },
        ]
      });
    } else if (department === 'migraine') {
      baseConditions.push({
        $and: [
          { department: { $ne: 'piles' } },
          { 'order_items.name': { $not: PILES_REGEX } },
          { 'order_items.sku': { $not: PILES_REGEX } },
          { 'products.name': { $not: PILES_REGEX } },
          { 'products.sku': { $not: PILES_REGEX } },
          { product_name: { $not: PILES_REGEX } },
          { problem: { $not: PILES_REGEX } },
          { remarks: { $not: PILES_REGEX } },
        ]
      });
    }
  }

  // Build status variants: use alias map if available, otherwise fall back to short-code reverse lookup
  const aliasVariants = STATUS_ALIASES[queryStatus];
  const allVariants = aliasVariants || (() => {
    const reverseShortCodes = Object.entries(SMX_STATUS_MAP)
      .filter(([, fullName]) => fullName === queryStatus)
      .map(([shortCode]) => shortCode);
    return [queryStatus, ...reverseShortCodes];
  })();

  // Flexible case-insensitive match for each variant (allowing space, hyphen, or underscore)
  baseConditions.push({ status: { $in: allVariants.map(s => new RegExp(`^${s.replace(/[-_]/g, '[-_ ]')}$`, 'i')) } });

  if (from && to) {
    const dateFilter = {
      $gte: new Date(from + 'T00:00:00.000+05:30'),
      $lte: new Date(to + 'T23:59:59.999+05:30'),
    };

    let dateOrClause;
    if (/^(delivered|rto_delivered|DEL|RTO|RTD)$/i.test(queryStatus)) {
      // Terminal status: prefer delivered_at, fallback to status_updated_at, then createdAt
      dateOrClause = {
        $or: [
          { delivered_at: dateFilter },
          { $and: [{ $or: [{ delivered_at: { $exists: false } }, { delivered_at: null }] }, { status_updated_at: dateFilter }] },
          { $and: [{ $or: [{ delivered_at: { $exists: false } }, { delivered_at: null }] }, { $or: [{ status_updated_at: { $exists: false } }, { status_updated_at: null }] }, { createdAt: dateFilter }] },
        ]
      };
    } else if (/^cancell?ed$/i.test(queryStatus)) {
      // Cancelled: apply date filter
      dateOrClause = {
        $or: [
          { status_updated_at: dateFilter },
          { status_updated_at: { $exists: false }, createdAt: dateFilter },
          { status_updated_at: null, createdAt: dateFilter },
        ]
      };
    } else if (ATTEMPT_STATUSES_RE.test(queryStatus)) {
      // ATTEMPT statuses (UNDELIVERED_*, PICKUP_FAILED, etc.): filter by status_updated_at
      // Shows only orders whose delivery attempt happened within the date range
      dateOrClause = {
        $or: [
          { status_updated_at: dateFilter },
          { $or: [{ status_updated_at: { $exists: false } }, { status_updated_at: null }], createdAt: dateFilter },
        ]
      };
    } else if (PIPELINE_STATUSES_RE.test(queryStatus)) {
      // Pipeline statuses: restrict to last 38 days to match board counts and exclude stale untracked shipments
      dateOrClause = {
        createdAt: { $gte: new Date(Date.now() - 38 * 24 * 60 * 60 * 1000) }
      };
    }

    if (dateOrClause) {
      baseConditions.push(dateOrClause);
    }
  }

  const match = { $and: baseConditions };

  // For staff roles (non-admin), filter DELIVERED/RTO_DELIVERED by verified_by = current user
  const isDeliveredStatus = /^(delivered|rto_delivered|DEL|RTO|RTD)$/i.test(queryStatus);
  const userRole = req.user?.role;
  const isStaff = userRole && !['admin', 'superadmin', 'super_admin', 'manager', 'logistic', 'logistics', 'ndr'].includes(userRole.toLowerCase());
  if (isDeliveredStatus && isStaff && req.user?._id) {
    match.verified_by = req.user._id;
  }

  const sortCriteria = isDeliveredStatus
    ? { delivered_at: -1, status_updated_at: -1, createdAt: -1, _id: -1 }
    : { createdAt: -1, status_updated_at: -1, _id: -1 };

  const orders = await Order.find(match)
    .populate({ path: 'lead_id', select: 'name phone email assignedTo', populate: { path: 'assignedTo', select: 'name role' } })
    .populate('verified_by', 'name role')
    .populate('created_by', 'name role')
    .populate('comments.createdBy', 'name role')
    .sort(sortCriteria)
    .limit(Math.min(Number(limit) || 50, 500)).lean();

  // Backfill missing customer data from raw_response or lead_id
  for (const o of orders) {
    if (!o.billing_customer_name || !o.billing_phone) {
      const raw = o.raw_response;
      if (raw) {
        const c = raw.customer || raw;
        if (!o.billing_customer_name) o.billing_customer_name = c.name || raw.billing_customer_name || raw.customer_name || '';
        if (!o.billing_phone) o.billing_phone = c.phone || raw.billing_phone || raw.phone || '';
        if (!o.billing_city) o.billing_city = c.city || raw.billing_city || raw.city || '';
        if (!o.billing_state) o.billing_state = c.state || raw.billing_state || raw.state || '';
        if (!o.billing_pincode) o.billing_pincode = c.pincode || raw.billing_pincode || raw.pincode || '';
      }
      // Also try lead_id populated name/phone
      if (!o.billing_customer_name && o.lead_id?.name) o.billing_customer_name = o.lead_id.name;
      if (!o.billing_phone && o.lead_id?.phone) o.billing_phone = o.lead_id.phone;
    }
  }

  const unlinked = orders.filter(o => !o.lead_id || !o.lead_id.assignedTo);

  if (unlinked.length > 0) {
    const phones = unlinked.map(o => String(o.billing_phone || '').replace(/\D/g, '')).filter(p => p.length >= 10 && !/^x+$/i.test(p));
    const names = unlinked.map(o => (o.billing_customer_name || '').toLowerCase().trim()).filter(Boolean);
    const pins = unlinked.map(o => String(o.billing_pincode || '').trim()).filter(p => p.length === 6);

    const leads = await Lead.find({
      isDeleted: { $ne: true },
      $or: [
        { phone: { $in: phones } },
        { name: { $in: names } },
        { pincode: { $in: pins } }
      ]
    }).select('name phone email address pincode assignedTo').populate('assignedTo', 'name role').lean();

    const byPhone = {};
    const byName = {};
    const byPin = {};
    const pinCount = {};

    leads.forEach(l => {
      if (l.phone) byPhone[String(l.phone).replace(/\D/g, '')] = l;
      if (l.name) byName[l.name.toLowerCase().trim()] = l;
      if (l.pincode) {
        pinCount[l.pincode] = (pinCount[l.pincode] || 0) + 1;
        byPin[l.pincode] = l;
      }
    });
    // Remove ambiguous pincode matches
    Object.keys(pinCount).forEach(p => { if (pinCount[p] > 1) delete byPin[p]; });

    orders.forEach(o => {
      let staffName = o.verified_by?.name || o.lead_id?.assignedTo?.name || '';
      let staffRole = o.verified_by?.role || o.lead_id?.assignedTo?.role || '';
      let lead = o.lead_id || null;

      if (!staffName) {
        const cleanPhone = String(o.billing_phone || '').replace(/\D/g, '');
        const matchedLead = (cleanPhone.length >= 10 && byPhone[cleanPhone]) ||
          byName[(o.billing_customer_name || '').toLowerCase().trim()] ||
          byPin[String(o.billing_pincode || '').trim()];
        if (matchedLead) {
          staffName = matchedLead.assignedTo?.name || '';
          staffRole = matchedLead.assignedTo?.role || '';
          if (!lead) lead = matchedLead;
        }
      }

      o.staff_name = staffName;
      o.staff_role = staffRole;
      if (!o.sub_total && o.raw_response) { const r = o.raw_response; o.sub_total = Number(r.total_amount || r.sub_total || r.amount || r.total_price || 0); }

      if (lead) {
        if (!o.billing_customer_name || o.billing_customer_name === '-') o.billing_customer_name = lead.name;
        if (!o.billing_phone || /^x+$/i.test(o.billing_phone) || o.billing_phone === '-') o.billing_phone = lead.phone;
      }
    });
  } else {
    orders.forEach(o => {
      o.staff_name = o.verified_by?.name || o.lead_id?.assignedTo?.name || '';
      o.staff_role = o.verified_by?.role || o.lead_id?.assignedTo?.role || '';
      const lead = o.lead_id;
      if (lead) {
        if (!o.billing_customer_name || o.billing_customer_name === '-') o.billing_customer_name = lead.name;
        if (!o.billing_phone || /^x+$/i.test(o.billing_phone) || o.billing_phone === '-') o.billing_phone = lead.phone;
      }
    });
  }

  res.json(new ApiResponse(200, { data: orders, total: orders.length }, 'Status orders fetched'));
});

export const saveOrderNote = catchAsync(async (req, res) => {
  const { id } = req.params;
  const { text, type = 'general', section = '' } = req.body;
  if (!text) return res.status(400).json(new ApiResponse(400, null, 'text is required'));

  const comment = {
    text,
    type,
    section,
    createdBy: req.user._id,
    createdAt: new Date()
  };

  let order = await Order.updateWithTransaction(
    { _id: id, platform: 'shipmaxx' },
    { $push: { comments: comment } },
    { returnDocument: 'after' }
  );

  if (!order) return res.status(404).json(new ApiResponse(404, null, 'Order not found'));

  order = await Order.populate(order, { path: 'comments.createdBy', select: 'name role' });

  // Since `.lean()` was originally used (but wouldn't work on the returned doc directly), 
  // we can use `.toObject()` or just respond with the populated document's comments.
  const comments = order.toObject ? order.toObject().comments : order.comments;
  invalidateFollowupCache();
  res.json(new ApiResponse(200, comments || [], 'Order note saved'));
});

export const importOrders = catchAsync(async (req, res) => {
  // ShipMaxx does not provide a list-all-orders API endpoint.
  // Orders are created in CRM via createOrder and tracked via AWB.
  // This endpoint syncs tracking status for all existing CRM orders that have an AWB.
  const activeOrders = await Order.find({
    platform: 'shipmaxx',
    awb_code: { $exists: true, $ne: '' },
    $or: [
      { status: { $not: /^(delivered|rto_delivered)/i } },
      { status: /^(delivered|rto_delivered)/i, delivered_at: { $exists: false } },
      { status: /^(delivered|rto_delivered)/i, delivered_at: null }
    ]
  }).lean();

  let updatedCount = 0;
  for (const o of activeOrders) {
    try {
      const trackRes = await smx.trackShipment(o.awb_code);
      const tracking = trackRes?.data?.data || trackRes?.data || trackRes || {};
      const status = tracking.current_status || tracking.status || tracking.shipment_status || tracking.delivery_status || tracking.history?.[0]?.system_status_name || tracking.history?.[0]?.system_status_code || tracking.history?.[0]?.status;
      if (status) {
        const update = { status: status.toUpperCase(), status_updated_at: new Date() };

        let actualDate = null;
        const history = tracking.history || tracking.tracking_history || [];
        if (Array.isArray(history) && history.length > 0) {
          const latest = history[0]; // assuming descending order, or we could find the 'Delivered' event
          const dateStr = latest.date || latest.timestamp || latest.time;
          if (dateStr) {
            actualDate = parseShipMaxxDate(dateStr);
          }
        }

        if (update.status === 'DELIVERED') {
          const existing = await Order.findOne({ _id: o._id }).lean();
          if (!existing || !existing.delivered_at) {
            update.delivered_at = actualDate || new Date();
            update.status_updated_at = actualDate || new Date();
          } else {
            update.status_updated_at = actualDate || new Date(); // Keep existing delivered_at
          }
        } else {
          update.status_updated_at = actualDate || new Date();
        }

        await Order.updateWithTransaction({ _id: o._id }, { $set: update });
        updatedCount++;
      }
    } catch (err) {
      console.error(`[ShipMaxx Import] AWB ${o.awb_code} track error:`, err.message);
    }
  }

  res.json(new ApiResponse(200, {
    imported: 0,
    skipped: 0,
    updated: updatedCount,
    total: activeOrders.length,
    note: 'ShipMaxx has no list-orders API. Tracking status updated for existing CRM orders with AWB.'
  }, `Sync complete. Updated ${updatedCount} of ${activeOrders.length} active shipments.`));
});

//Import by Order ID list (ShipMaxx has no list endpoint — fetch one by one) ─
export const importByIds = catchAsync(async (req, res) => {
  const { order_ids } = req.body;
  if (!Array.isArray(order_ids) || order_ids.length === 0)
    return res.status(400).json(new ApiResponse(400, null, 'order_ids array is required'));

  const ids = [...new Set(order_ids.map(id => String(id).trim()).filter(Boolean))];
  if (ids.length > 500)
    return res.status(400).json(new ApiResponse(400, null, 'Maximum 500 order IDs per request'));

  let imported = 0, updated = 0, skipped = 0, failed = 0;
  const errors = [];

  for (const order_id of ids) {
    try {
      // Fetch full order details from ShipMaxx
      const raw = await smx.getOrder(order_id);
      const o = raw?.data || raw || {};

      if (!o || !o.order_id && !o.id) {
        skipped++;
        errors.push({ order_id, reason: 'Empty response from ShipMaxx' });
        continue;
      }

      const smxOrderId = String(o.order_id || o.id);
      const customer = o.customer || {};
      const existing = await Order.findOne({ order_id: smxOrderId, platform: 'shipmaxx' }).lean();

      const fields = {
        order_id: smxOrderId,
        status: String(o.status || 'NEW').toUpperCase(),
        billing_customer_name: customer.name || o.billing_customer_name || '',
        billing_phone: customer.phone || o.billing_phone || '',
        billing_address: customer.address || o.billing_address || '',
        billing_city: customer.city || o.billing_city || '',
        billing_state: customer.state || o.billing_state || '',
        billing_pincode: customer.pincode || o.billing_pincode || '',
        billing_email: customer.email || o.billing_email || '',
        payment_method: o.payment_method || '',
        sub_total: Number(o.total_amount || o.sub_total || o.amount) || 0,
        awb_code: o.awb || o.awb_number || o.awb_code || '',
        courier_name: o.carrier_name || o.courier_name || '',
        order_items: (o.products || o.items || []).map(p => ({
          name: p.name, sku: p.sku, units: p.quantity, selling_price: p.price
        })),
        weight: o.package?.weight,
        length: o.package?.length,
        breadth: o.package?.width,
        height: o.package?.height,
        platform: 'shipmaxx',
        status_updated_at: new Date(),
        raw_response: o,
      };

      if (existing) {
        await Order.updateWithTransaction({ _id: existing._id }, { $set: fields });
        updated++;
      } else {
        await Order.create(fields);
        imported++;
      }
    } catch (err) {
      console.error(`[ShipMaxx ImportByIds] ID ${order_id}:`, err.message);
      failed++;
      errors.push({ order_id, reason: err.message });
    }
  }

  res.json(new ApiResponse(200, {
    total: ids.length, imported, updated, skipped, failed,
    errors: errors.slice(0, 20),
  }, `Done: ${imported} new, ${updated} updated, ${failed} failed out of ${ids.length} order IDs`));
});
let isSyncingRunning = false;

export const runSyncInBackground = async (mode = 'quick') => {
  if (isSyncingRunning) {
    console.log('[Sync ShipMaxx] ⚠ Sync already running, skipping this trigger.');
    return;
  }
  isSyncingRunning = true;
  try {
    const syncStart = Date.now();
    const MAX_SYNC_MS = 4 * 60 * 1000;
    const isTimedOut = () => (Date.now() - syncStart) > MAX_SYNC_MS;
    let updatedCount = 0;
    const isFullSync = mode === 'full';

    console.log(`[Sync ShipMaxx] ▶ Starting ${isFullSync ? 'FULL' : 'QUICK'} sync in background...`);

    // Status normalization (fast, DB only)
    await Order.updateMany({ platform: 'shipmaxx', status: 'SHIPMENT_BOOKED' }, { $set: { status: 'IN_TRANSIT' } }).catch(() => { });
    await Order.updateMany({ platform: 'shipmaxx', status: 'SHIPMENT_CANCELLED' }, { $set: { status: 'CANCELLED' } }).catch(() => { });
    await Order.updateMany({ platform: 'shipmaxx', status: 'RTO_INTRANSIT' }, { $set: { status: 'RTO_IN_TRANSIT' } }).catch(() => { });
    for (const [sc, fs] of Object.entries(SMX_STATUS_MAP)) {
      if (sc.toUpperCase() === fs.toUpperCase()) continue;
      await Order.updateMany({ platform: 'shipmaxx', status: new RegExp(`^${sc}$`, 'i') }, { $set: { status: fs } }).catch(() => { });
    }

    // ─── Import shipments + orders from ShipMaxx API ─────────
    const maxPages = isFullSync ? 50 : 2;
    if (!isTimedOut()) {
      try {
        let page = 1;
        while (!isTimedOut() && page <= maxPages) {
          const shipRes = await smx.getShipments({ limit: 50, per_page: 50, page });
          const shipments = shipRes?.data?.data || shipRes?.data || [];
          if (shipments.length === 0) break;
          for (const s of shipments) {
            if (!s.awb && !s.order_id) continue;
            const query = { platform: 'shipmaxx' };
            if (s.order_id) query.order_id = String(s.order_id); else query.awb_code = String(s.awb);
            const newStatus = normalizeShipmaxxStatus(s.status);
            const existing = await Order.findOne(query).select('status status_updated_at payment_method courier_name order_items createdAt').lean();
            let statusUpdatedAt = s.date_added ? new Date(s.date_added) : new Date();
            let finalStatus = newStatus;
            if (existing) {
              if (newStatus !== existing.status && newStatus !== 'UNKNOWN') {
                statusUpdatedAt = new Date();
              } else {
                statusUpdatedAt = existing.status_updated_at || statusUpdatedAt;
              }
              if (newStatus === 'UNKNOWN') finalStatus = existing.status;
            }

            const updateData = { order_id: String(s.order_id || s.awb), awb_code: String(s.awb || ''), platform: 'shipmaxx', status_updated_at: statusUpdatedAt };

            const isGenericUndelivered = (st) => /^(undelivered|undelivered_attempt_failure|undelivered_failure)$/i.test(st);
            const isSpecificUndelivered = (st) => /^undelivered_\d(st|nd|rd)_attempt$/i.test(st);
            let shouldUpdateStatus = true;
            const protectedStatuses = ['DELIVERED', 'RTO_DELIVERED'];
            if (existing) {
              if (protectedStatuses.includes(existing.status)) {
                shouldUpdateStatus = false;
              } else if (isSpecificUndelivered(existing.status) && isGenericUndelivered(finalStatus)) {
                shouldUpdateStatus = false;
              }
            }
            if (shouldUpdateStatus) {
              updateData.status = finalStatus;
            }

            if (s.payment_method && (!existing || !existing.payment_method)) {
              updateData.payment_method = s.payment_method;
            }
            const courier = s.carrier_name || s.courier_name || s.carrier;
            if (courier && (!existing || !existing.courier_name)) {
              updateData.courier_name = courier;
            }
            if (!existing) {
              if (s.created_at) updateData.createdAt = new Date(s.created_at); else if (s.date_added) updateData.createdAt = new Date(s.date_added);
            }
            if (s.products && Array.isArray(s.products) && (!existing || !existing.order_items || existing.order_items.length === 0)) {
              updateData.order_items = s.products.map(p => ({ name: p.name, sku: p.sku, units: p.quantity }));
            }
            await Order.updateWithTransaction(query, { $set: updateData }, { upsert: true }).catch(() => { });
            updatedCount++;
          }
          console.log(`[Sync ${isFullSync ? 'Full' : 'Quick'}] shipments page ${page}`);
          await new Promise(r => setTimeout(r, 200)); page++;
        }
      } catch (err) { console.error(`[Sync ${isFullSync ? 'Full' : 'Quick'}] Shipments error:`, err.message); }

      try {
        let op = 1;
        while (!isTimedOut() && op <= maxPages) {
          const ordersRes = await smx.fetchAllOrders({ limit: 50, per_page: 50, page: op });
          const orders = ordersRes?.data?.data || ordersRes?.data || ordersRes?.orders || [];
          if (orders.length === 0) break;
          for (const o of orders) {
            if (!o.order_id) continue;
            const query = { platform: 'shipmaxx', order_id: String(o.order_id) };
            const existing = await Order.findOne(query).select('status lead_id billing_customer_name billing_phone billing_address billing_pincode sub_total courier_name awb_code order_items createdAt').lean();

            const cCust = o.customer || o.billing_address || {};
            const ud = { platform: 'shipmaxx', order_id: String(o.order_id) };
            if (o.customer_name && (!existing || !existing.billing_customer_name)) ud.billing_customer_name = o.customer_name || cCust.name || cCust.first_name || '';
            if (o.phone && (!existing || !existing.billing_phone)) ud.billing_phone = o.phone || cCust.phone || '';
            if (o.address && (!existing || !existing.billing_address)) ud.billing_address = o.address || cCust.address || '';
            const zip = o.billing_zip || o.shipping_zip || cCust.zip || cCust.pincode;
            if (zip && (!existing || !existing.billing_pincode)) ud.billing_pincode = zip || '';
            if (o.total_price && (!existing || !existing.sub_total)) ud.sub_total = Number(o.total_price || (o.totals?.find?.(t => t.code === 'total')?.value)) || 0;

            const c = o.carrier_name || o.courier_name || o.carrier;
            if (c && (!existing || !existing.courier_name)) ud.courier_name = c;
            if (!existing && o.created_at) ud.createdAt = new Date(o.created_at);
            if (o.awb && (!existing || !existing.awb_code)) ud.awb_code = String(o.awb);

            if (o.status) {
              const newStatus = normalizeShipmaxxStatus(o.status);
              const isGenericUndelivered = (st) => /^(undelivered|undelivered_attempt_failure|undelivered_failure)$/i.test(st);
              const isSpecificUndelivered = (st) => /^undelivered_\d(st|nd|rd)_attempt$/i.test(st);
              let shouldUpdateStatus = true;
              const protectedStatuses = ['DELIVERED', 'RTO_DELIVERED'];
              if (existing) {
                if (protectedStatuses.includes(existing.status)) {
                  shouldUpdateStatus = false;
                } else if (isSpecificUndelivered(existing.status) && isGenericUndelivered(newStatus)) {
                  shouldUpdateStatus = false;
                }
              }
              if (shouldUpdateStatus) {
                ud.status = newStatus;
              }
            }

            if (o.order_products && Array.isArray(o.order_products) && (!existing || !existing.order_items || existing.order_items.length === 0)) {
              ud.order_items = o.order_products.map(p => ({
                name: p.title || p.name || '',
                sku: p.sku || '',
                units: Number(p.quantity) || 1,
                selling_price: Number(p.price) || 0
              }));
            }
            await Order.updateWithTransaction(query, { $set: ud }, { upsert: true }).catch(() => { });
          }
          console.log(`[Sync ${isFullSync ? 'Full' : 'Quick'}] orders page ${op}`);
          await new Promise(r => setTimeout(r, 200)); op++;
        }
      } catch (err) { console.error(`[Sync ${isFullSync ? 'Full' : 'Quick'}] Orders error:`, err.message); }

      // Bulk courier update
      try {
        const all = await Order.find({ platform: 'shipmaxx', awb_code: { $exists: true, $ne: '' } }).select('awb_code courier_name').lean();
        const ops = []; for (const o of all) { const c = guessCourierByAwb(o.awb_code); if (c && c !== o.courier_name) ops.push({ updateOne: { filter: { _id: o._id }, update: { $set: { courier_name: c } } } }); }
        if (ops.length > 0) await Order.bulkWrite(ops).catch(() => { });
      } catch (err) { }

      // Missing details
      try {
        const missing = await Order.find({ platform: 'shipmaxx', order_id: { $exists: true, $ne: '' }, $or: [{ billing_address: { $in: [null, '', '-'] } }, { billing_address: { $exists: false } }, { billing_city: { $in: [null, '', '-'] } }, { billing_city: { $exists: false } }, { billing_customer_name: { $in: [null, '', '-'] } }, { billing_customer_name: { $exists: false } }] }).select('order_id').lean().limit(50);
        for (const o of missing) {
          if (isTimedOut()) break;
          try {
            const raw = await smx.getOrder(o.order_id); const d = raw?.data?.order || raw?.data || raw || {};
            if (d.billing_customer_name || d.shipping_customer_name || d.customer || d.billing_address || d.shipping_address) {
              const u = {
                billing_customer_name: d.billing_customer_name || d.shipping_customer_name || d.customer_name || d.customer?.name || d.billing_address?.name || '',
                billing_phone: d.billing_phone || d.shipping_phone || d.phone || d.customer?.phone || d.billing_address?.phone || '',
                billing_address: d.billing_address || d.shipping_address || d.address || d.billing_address?.address || d.customer?.address || '',
                billing_city: d.billing_city || d.shipping_city || d.city || d.billing_address?.city || d.customer?.city || '',
                billing_state: d.billing_state || d.shipping_state || d.state || d.billing_address?.state || d.customer?.state || '',
                billing_pincode: d.billing_pincode || d.shipping_pincode || d.billing_zip || d.shipping_zip || d.billing_address?.zip || d.customer?.zip || '',
                sub_total: Number(d.sub_total || d.total_price || d.totals?.find(t => t.code === 'total')?.value) || 0
              };
              if (d.products?.length > 0) u.order_items = d.products.map(p => ({ name: p.name || 'Product', sku: p.sku || '', units: Number(p.quantity) || 1, selling_price: Number(p.price || p.selling_price) || 0 }));
              // Remove empty fields to avoid overwriting existing valid data with blanks
              Object.keys(u).forEach(k => { if (u[k] === '' || u[k] === null || u[k] === undefined) delete u[k]; });
              await Order.updateWithTransaction({ _id: o._id }, { $set: u });
            }
          } catch (e) { }
        }
      } catch (err) { }
      console.log(`[Sync Full] Import done (${Math.round((Date.now() - syncStart) / 1000)}s)`);
    }
    // ─── Track active orders (parallel batches of 10) ───────────────────────
    if (!isTimedOut()) {
      const activeOrders = await Order.find({ platform: 'shipmaxx', awb_code: { $exists: true, $ne: '' }, status: { $not: /^(delivered|rto_delivered|cancelled|canceled)/i } }).lean();
      console.log(`[Sync] Tracking ${activeOrders.length} active orders...`);
      const BATCH = 10;
      for (let i = 0; i < activeOrders.length; i += BATCH) {
        if (isTimedOut()) { console.log(`[Sync] ⚠ Timed out at ${i}/${activeOrders.length}`); break; }
        await Promise.allSettled(activeOrders.slice(i, i + BATCH).map(async (o) => {
          try {
            const trackRes = await smx.trackShipment(o.awb_code);
            const tracking = trackRes?.data?.data || trackRes?.data || trackRes || {};
            const rawStatus = tracking.current_status || tracking.status || tracking.shipment_status || tracking.delivery_status || tracking.history?.[0]?.system_status_name || tracking.history?.[0]?.system_status_code || tracking.history?.[0]?.status;
            if (!rawStatus) return;
            let status = normalizeShipmaxxStatus(rawStatus);
            const ndrKw = ['EXCEPTION', 'REFUSED', 'NOT AVAILABLE', 'INCOMPLETE', 'ACTION TAKEN', 'ATTEMPT FAILURE', 'ADDRESS'];
            if (status === 'UNDELIVERED' || status === 'UNDELIVERED_ATTEMPT_FAILURE' || status === 'UNDELIVERED_FAILURE' || (ndrKw.some(k => status.includes(k)) && !status.includes('DELIVERED'))) {
              const a = o.delivery_attempt || 1; status = a === 1 ? 'UNDELIVERED_1ST_ATTEMPT' : a === 2 ? 'UNDELIVERED_2ND_ATTEMPT' : a === 3 ? 'UNDELIVERED_3RD_ATTEMPT' : 'UNDELIVERED';
            }
            const statusChanged = status !== o.status;
            const update = { status };
            if (!o.courier_name && o.awb_code) { const g = guessCourierByAwb(o.awb_code); if (g) update.courier_name = g; }
            if (statusChanged) {
              // Status changed — derive real timestamp from history, fall back to now
              update.status_updated_at = tracking.history?.length > 0
                ? extractStatusUpdatedAt(tracking, status)
                : new Date();
            } else {
              // Status unchanged — preserve existing timestamp, do NOT re-stamp with today
              update.status_updated_at = o.status_updated_at || new Date();
            }
            if (status === 'DELIVERED') {
              let delAt = null;
              if (tracking.history) { const de = tracking.history.find(h => h.system_status_code === 'DEL' || (h.system_status_name || '').toLowerCase() === 'delivered' || (h.status || '').toLowerCase() === 'delivered'); if (de?.date || de?.timestamp) delAt = parseShipMaxxDate(de.date || de.timestamp); }
              if (delAt) { update.delivered_at = delAt; update.status_updated_at = delAt; }
              else { const dd = await Order.findOne({ _id: o._id }).select('delivered_at status_updated_at').lean(); update.delivered_at = dd?.delivered_at || dd?.status_updated_at || update.status_updated_at || o.status_updated_at || new Date(); }
              if (o.lead_id) await Lead.findByIdAndUpdate(o.lead_id, { status: 'follow_up' }).catch(() => { });
            }
            await Order.updateWithTransaction({ _id: o._id }, { $set: update });
            updatedCount++;
          } catch (err) { console.error(`[Sync] AWB ${o.awb_code}:`, err.message); }
        }));
        // Wait 1.5 seconds between batches to avoid rate limit
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
      console.log(`[Sync] Tracking done (${updatedCount} updated, ${Math.round((Date.now() - syncStart) / 1000)}s)`);
    }

    // Auto followups
    if (!isTimedOut()) {
      const nfu = await Order.find({ platform: 'shipmaxx', status: /^delivered$/i, auto_followups_set: { $ne: true } }).select('_id delivered_at createdAt').lean();
      for (const o of nfu) await setAutoFollowUps(o._id, o.delivered_at || o.createdAt || new Date());
    }

    const elapsed = Math.round((Date.now() - syncStart) / 1000);
    console.log(`[Sync ShipMaxx] ✅ ${isFullSync ? 'Full' : 'Quick'} sync done! ${updatedCount} updated in ${elapsed}s`);
  } finally {
    isSyncingRunning = false;
  }
};

export const syncShipmaxx = catchAsync(async (req, res) => {
  const mode = (req.query?.mode || req.body?.mode || 'full').toLowerCase();

  // Return immediately so Hostinger doesn't timeout the HTTP request
  res.json(new ApiResponse(200, { mode }, `Sync started in background. This might take a few minutes.`));

  // Run background process
  runSyncInBackground(mode).catch(err => {
    console.error('[Background Sync Error]', err.message);
  });
});

export const runCronSyncWebhook = catchAsync(async (req, res) => {
  // Return immediately so external cron (Hostinger/cron-job.org) doesn't hit 30s HTTP timeout
  res.json(new ApiResponse(200, null, 'ShipMaxx cron sync triggered in background'));

  // Run sync in background
  import('./shipmaxx.cron.js').then(cronModule => {
    if (cronModule && cronModule.runCronSync) {
      cronModule.runCronSync().catch(err => {
        console.error('[Cron Webhook Sync Error]', err.message);
      });
    }
  }).catch(err => {
    console.error('[Cron Webhook Import Error]', err.message);
  });
});


export const getOrders = catchAsync(async (req, res) => {
  const { status, shipment_status, from, to, search, page = 1, limit = 50, has_awb } = req.query;
  const match = { platform: 'shipmaxx' };

  if (has_awb === 'true') {
    match.awb_code = { $exists: true, $ne: '' };
  }

  if (shipment_status) {
    const mapped = SMX_STATUS_MAP[String(shipment_status).trim().toUpperCase()];
    if (mapped) {
      match.status = mapped;
    } else {
      match.status = String(shipment_status).trim().toUpperCase();
    }
  } else if (status && status !== 'all') {
    const statusVariant = status.replace(/[-_]/g, '[-_ ]');
    if (/^undelivered$/i.test(status)) {
      match.status = { $regex: /^undelivered/i };
    } else {
      match.status = new RegExp(`^${statusVariant}$`, 'i');
    }
  }

  if (from && to) {
    match.createdAt = {
      $gte: new Date(from + 'T00:00:00.000+05:30'),
      $lte: new Date(to + 'T23:59:59.999+05:30'),
    };
  }

  if (search) {
    const q = String(search).trim();
    match.$or = [
      { order_id: { $regex: q, $options: 'i' } },
      { awb_code: { $regex: q, $options: 'i' } },
      { billing_customer_name: { $regex: q, $options: 'i' } },
      { billing_phone: { $regex: q, $options: 'i' } },
    ];
  }

  const pg = Math.max(1, Number(page) || 1);
  const lim = Math.min(200, Math.max(1, Number(limit) || 50));

  const [orders, total] = await Promise.all([
    Order.find(match)
      .populate({ path: 'lead_id', select: 'phone email assignedTo', populate: { path: 'assignedTo', select: 'name role' } })
      .populate('verified_by', 'name role')
      .populate('comments.createdBy', 'name role')
      .sort({ createdAt: -1, _id: -1 })
      .skip((pg - 1) * lim)
      .limit(lim)
      .lean(),
    Order.countDocuments(match)
  ]);

  orders.forEach(o => {
    if (o.source_order_id && o.verified_by) {
      o.staff_name = o.verified_by.name || '';
      o.staff_role = o.verified_by.role || '';
    } else {
      o.staff_name = o.lead_id?.assignedTo?.name || '';
      o.staff_role = o.lead_id?.assignedTo?.role || '';
    }
  });

  res.json(new ApiResponse(200, { data: orders, total }, 'Orders fetched successfully'));
});


// ── Delivered Orders ──────────────────────────────────────────────────────────
export const getDeliveredOrders = catchAsync(async (req, res) => {
  const { search, page = 1, per_page = 50, from, to, payment_method } = req.query;
  const statusFilter = { $in: [/^delivered$/i, /^DEL$/i] };
  const baseConditions = [
    { platform: 'shipmaxx', status: statusFilter }
  ];

  if (from || to) {
    const dateFilter = {};
    if (from) dateFilter.$gte = new Date(from + 'T00:00:00.000+05:30');
    if (to) dateFilter.$lte = new Date(to + 'T23:59:59.999+05:30');

    baseConditions.push({
      $or: [
        { delivered_at: dateFilter },
        { $and: [{ $or: [{ delivered_at: { $exists: false } }, { delivered_at: null }] }, { status_updated_at: dateFilter }] },
        { $and: [{ $or: [{ delivered_at: { $exists: false } }, { delivered_at: null }] }, { $or: [{ status_updated_at: { $exists: false } }, { status_updated_at: null }] }, { createdAt: dateFilter }] }
      ]
    });
  }

  if (payment_method && payment_method !== 'all') {
    if (payment_method === 'cod') {
      baseConditions.push({ payment_method: { $regex: 'cod', $options: 'i' } });
    } else if (payment_method === 'prepaid') {
      baseConditions.push({ payment_method: { $not: /cod/i } });
    }
  }

  if (search) {
    const q = String(search).trim();
    baseConditions.push({
      $or: [
        { billing_customer_name: { $regex: q, $options: 'i' } },
        { billing_phone: { $regex: q, $options: 'i' } },
        { order_id: { $regex: q, $options: 'i' } },
        { awb_code: { $regex: q, $options: 'i' } },
      ]
    });
  }

  const match = baseConditions.length === 1 ? baseConditions[0] : { $and: baseConditions };
  const isGetAll = per_page === 'all' || Number(per_page) <= 0 || Number(per_page) >= 10000;
  const limitNum = isGetAll ? 10000 : Math.max(1, Number(per_page) || 50);
  const pageNum = isGetAll ? 1 : Math.max(1, Number(page) || 1);
  const skipNum = isGetAll ? 0 : (pageNum - 1) * limitNum;

  const [orders, total, totalRevenueAgg] = await Promise.all([
    Order.find(match)
      .populate({ path: 'lead_id', select: 'phone email assignedTo', populate: { path: 'assignedTo', select: 'name role' } })
      .populate('verified_by', 'name role')
      .sort({ delivered_at: -1, createdAt: -1, _id: -1 })
      .skip(skipNum).limit(limitNum).lean(),
    Order.countDocuments(match),
    Order.aggregate([
      { $match: match },
      { $group: { _id: null, totalRevenue: { $sum: '$sub_total' } } }
    ])
  ]);

  const totalRevenue = totalRevenueAgg?.[0]?.totalRevenue || 0;

  // Ensure delivered orders have sequential bill numbers (TW-0001, TW-0002, TW-0003...)
  const allDelivered = await Order.find({ platform: 'shipmaxx', status: statusFilter })
    .sort({ delivered_at: 1, status_updated_at: 1, createdAt: 1, _id: 1 })
    .select('_id bill_seq bill_number')
    .lean();

  const seqMap = new Map();
  if (allDelivered.length > 0) {
    let seq = 1;
    const bulkOps = [];
    for (const ord of allDelivered) {
      const seqStr = String(seq).padStart(4, '0');
      const generatedNum = `TW-${seqStr}`;
      seqMap.set(String(ord._id), { seq, billNumber: generatedNum });
      if (ord.bill_seq !== seq || ord.bill_number !== generatedNum) {
        bulkOps.push({
          updateOne: {
            filter: { _id: ord._id },
            update: { $set: { bill_seq: seq, bill_number: generatedNum } }
          }
        });
      }
      seq++;
    }
    if (bulkOps.length > 0) {
      await Order.bulkWrite(bulkOps).catch(() => {});
    }
  }

  orders.forEach(o => {
    let staffName = undefined;
    let staffId = undefined;
    if (o.verified_by) {
      staffName = o.verified_by.name;
      staffId = o.verified_by._id || o.verified_by.id;
    }

    if (o.verified_by) {
      o.staff_name = staffName || '';
      o.staff_role = o.verified_by.role || '';
    } else {
      o.staff_name = o.lead_id?.assignedTo?.name || '';
      o.staff_role = o.lead_id?.assignedTo?.role || '';
    }
    o.verification_staff_id = staffId;
    o.verification_staff_name = staffName;

    // Set sequence-wise bill_number (e.g. TW-0001, TW-0002...)
    const seqData = seqMap.get(String(o._id));
    if (seqData) {
      o.bill_seq = seqData.seq;
      o.bill_number = seqData.billNumber;
      o.billNumber = seqData.billNumber;
    } else if (o.bill_seq) {
      const seqBillNum = `TW-${String(o.bill_seq).padStart(4, '0')}`;
      o.bill_number = seqBillNum;
      o.billNumber = seqBillNum;
    } else {
      const idPart = (o.order_id || o._id || '000').toString().replace(/\D/g, '').slice(-4) || '0001';
      o.bill_number = `TW-${idPart.padStart(4, '0')}`;
      o.billNumber = o.bill_number;
    }
  });
  res.json(new ApiResponse(200, { data: orders, total, totalRevenue, page: pageNum, per_page: isGetAll ? total : limitNum }, 'Delivered orders fetched'));
});

export const getDeliveredOrdersFromSchema = catchAsync(async (req, res) => {
  const { page = 1, per_page = 50, search, from, to } = req.query;

  // Auto-sync delivered orders from Order collection
  const newDelivered = await Order.find({ platform: 'shipmaxx', status: /^delivered$/i })
    .select('order_id billing_customer_name billing_phone billing_email billing_address billing_city billing_state billing_pincode awb_code courier_name payment_method sub_total order_items status lead_id delivered_at createdAt verified_by').lean();
  for (const o of newDelivered) {
    await DeliveredOrder.findOneAndUpdate(
      { order_id: o.order_id },
      { $set: { order_id: o.order_id, billing_customer_name: o.billing_customer_name || '', billing_phone: o.billing_phone || '', billing_email: o.billing_email || '', billing_address: o.billing_address || '', billing_city: o.billing_city || '', billing_state: o.billing_state || '', billing_pincode: o.billing_pincode || '', awb_code: o.awb_code || '', courier_name: o.courier_name || '', payment_method: o.payment_method || '', sub_total: o.sub_total || 0, order_items: o.order_items || [], status: o.status, lead_id: o.lead_id || null, verification_staff_id: o.verified_by || null, delivered_at: o.delivered_at || o.createdAt, order_date: o.createdAt } },
      { upsert: true }
    ).catch(() => { });
  }

  const skip = (Number(page) - 1) * Number(per_page);
  const matchQ = {};
  if (search) matchQ.$or = [
    { billing_customer_name: { $regex: search, $options: 'i' } },
    { billing_phone: { $regex: search, $options: 'i' } },
    { order_id: { $regex: search, $options: 'i' } },
    { awb_code: { $regex: search, $options: 'i' } },
  ];
  if (from || to) {
    matchQ.delivered_at = {};
    if (from) matchQ.delivered_at.$gte = new Date(from + 'T00:00:00.000+05:30');
    if (to) matchQ.delivered_at.$lte = new Date(to + 'T23:59:59.999+05:30');
  }
  let [data, total] = await Promise.all([
    DeliveredOrder.find(matchQ).sort({ delivered_at: -1 }).skip(skip).limit(Number(per_page))
      .populate('verification_staff_id', 'name customId id')
      .lean(),
    DeliveredOrder.countDocuments(matchQ),
  ]);

  data = data.map(item => {
    let staffName = undefined;
    let staffId = undefined;
    if (item.verification_staff_id) {
      staffName = item.verification_staff_id.name;
      staffId = item.verification_staff_id._id || item.verification_staff_id.id;
    }
    return {
      ...item,
      verification_staff_id: staffId || item.verification_staff_id,
      verification_staff_name: staffName
    };
  });

  res.json(new ApiResponse(200, { data, total }, 'Delivered orders fetched from schema'));
});

export const getInTransitOrdersFromSchema = catchAsync(async (req, res) => {
  const { page = 1, per_page = 50, search, from, to } = req.query;

  // Sync active orders into InTransitOrder
  const activeOrders = await Order.find({ platform: 'shipmaxx', status: { $not: /^(delivered|rto)/i } })
    .select('order_id billing_customer_name billing_phone billing_city billing_state billing_pincode awb_code courier_name payment_method sub_total order_items status lead_id status_updated_at createdAt').lean();
  for (const o of activeOrders) {
    await InTransitOrder.findOneAndUpdate(
      { order_id: o.order_id },
      { $set: { order_id: o.order_id, billing_customer_name: o.billing_customer_name || '', billing_phone: o.billing_phone || '', billing_city: o.billing_city || '', billing_state: o.billing_state || '', billing_pincode: o.billing_pincode || '', awb_code: o.awb_code || '', courier_name: o.courier_name || '', payment_method: o.payment_method || '', sub_total: o.sub_total || 0, order_items: o.order_items || [], status: o.status, lead_id: o.lead_id || null, status_updated_at: o.status_updated_at || o.createdAt, order_date: o.createdAt } },
      { upsert: true }
    ).catch(() => { });
  }
  await InTransitOrder.deleteMany({ status: { $regex: /^(delivered|rto)/i } }).catch(() => { });

  const skip = (Number(page) - 1) * Number(per_page);
  const matchQ = {};
  if (search) matchQ.$or = [
    { billing_customer_name: { $regex: search, $options: 'i' } },
    { billing_phone: { $regex: search, $options: 'i' } },
    { order_id: { $regex: search, $options: 'i' } },
    { awb_code: { $regex: search, $options: 'i' } },
  ];
  if (from || to) {
    matchQ.order_date = {};
    if (from) matchQ.order_date.$gte = new Date(from + 'T00:00:00.000+05:30');
    if (to) matchQ.order_date.$lte = new Date(to + 'T23:59:59.999+05:30');
  }
  const [data, total] = await Promise.all([
    InTransitOrder.find(matchQ).sort({ status_updated_at: -1 }).skip(skip).limit(Number(per_page)).lean(),
    InTransitOrder.countDocuments(matchQ),
  ]);
  res.json(new ApiResponse(200, { data, total }, 'In-transit orders fetched'));
});

async function getKitNumbersMap(ordersArray, OrderModel) {
  if (!ordersArray || ordersArray.length === 0) return {};

  const cleanPhones = ordersArray
    .map(o => String(o.billing_phone || '').replace(/\D/g, '').slice(-10))
    .filter(p => p.length === 10);
  const uniquePhones = [...new Set(cleanPhones)];

  if (uniquePhones.length === 0) return {};

  // Build indexed search targets (exact 10-digit, +91 prefixed, 91 prefixed, 0 prefixed)
  const phoneVariants = uniquePhones.flatMap(p => [
    p,
    `+91${p}`,
    `91${p}`,
    `0${p}`,
    `+91 ${p}`,
    `+91-${p}`
  ]);

  const historicalOrders = await OrderModel.find({
    platform: 'shipmaxx',
    status: /^(delivered|del)$/i,
    billing_phone: { $in: phoneVariants }
  }).select('_id billing_phone delivered_at status_updated_at createdAt').lean();

  const phoneHistory = {};
  for (const ho of historicalOrders) {
    const raw = String(ho.billing_phone || '').replace(/\D/g, '');
    const p10 = raw.slice(-10);
    if (!phoneHistory[p10]) phoneHistory[p10] = [];
    phoneHistory[p10].push(ho);
  }

  const orderKitMap = {};
  for (const p in phoneHistory) {
    const list = phoneHistory[p];
    list.sort((a, b) => new Date(a.delivered_at || a.status_updated_at || a.createdAt) - new Date(b.delivered_at || b.status_updated_at || b.createdAt));
    list.forEach((ho, index) => {
      orderKitMap[String(ho._id)] = index + 1;
    });
  }
  return orderKitMap;
}

// ── Follow-ups in-memory cache & single-flight deduplication ───────────────────
let followupCacheData = null;
let followupCacheTime = 0;
let followupPendingPromise = null;

export const invalidateFollowupCache = () => {
  followupCacheData = null;
  followupCacheTime = 0;
};

export const getOrdersWithFollowUps = catchAsync(async (req, res) => {
  const CACHE_TTL_MS = 10 * 60 * 1000; // 10m cache
  if (followupCacheData && (Date.now() - followupCacheTime < CACHE_TTL_MS)) {
    let cached = followupCacheData;
    if (req.user?.role === 'support') {
      const uid = String(req.user._id);
      const userDepts = req.user.departments || [];
      cached = followupCacheData.filter(o => {
        const assignedId = o.support_staff?._id || o.support_staff || o.followups?.find(f => !f.completed)?.staff?._id || o.followups?.find(f => !f.completed)?.staff;
        if (String(assignedId) !== uid) return false;
        const dept = o.department || detectOrderDepartment(o);
        return isDeptMatch(userDepts, dept);
      });
    }
    return res.json(new ApiResponse(200, cached, 'Orders with follow-ups fetched (cached)'));
  }

  if (followupPendingPromise) {
    const data = await followupPendingPromise;
    return res.json(new ApiResponse(200, data, 'Orders with follow-ups fetched'));
  }

  followupPendingPromise = (async () => {
    try {
      const query = {
        platform: 'shipmaxx',
        status: { $in: ['DELIVERED', 'delivered', 'DEL', 'del'] },
        followup_done: { $ne: true },
        sent_to_verification: { $ne: true },
      };

      const delivered = await Order.find(query)
        .select('_id order_id awb_code courier_name status delivery_attempt billing_customer_name billing_phone billing_email billing_address billing_city billing_state billing_pincode order_items payment_method sub_total lead_id created_by support_staff status_updated_at delivered_at createdAt problem notes comments followup_done sent_to_verification interakt_reply_text interakt_reply_at interakt_reply_read next_follow_up auto_followups_set department')
        .lean();

      if (!delivered || delivered.length === 0) {
        followupCacheData = [];
        followupCacheTime = Date.now();
        return [];
      }

      for (const o of delivered) {
        if (!o.delivered_at) {
          o.delivered_at = o.status_updated_at || o.createdAt;
        }
      }

      delivered.sort((a, b) => {
        const da = new Date(a.delivered_at || a.status_updated_at || a.createdAt || 0).getTime();
        const db = new Date(b.delivered_at || b.status_updated_at || b.createdAt || 0).getTime();
        return db - da;
      });

      // Auto-set followups in background
      const needsSetting = delivered.filter(o => !o.auto_followups_set);
      if (needsSetting.length) {
        Promise.all(needsSetting.map(o => setAutoFollowUps(o._id, o.delivered_at || o.status_updated_at || o.createdAt || new Date())))
          .catch(err => console.error('[ShipMaxx Background setAutoFollowUps error]:', err.message));
      }

      // Automatically balance any unassigned follow-ups across support staff by department
      distributeUnassignedFollowupsEqually().catch(err => console.error('[ShipMaxx distributeUnassignedFollowupsEqually error]:', err.message));

      // Auto-advance missed/past-cycle followups to the next call stage
      await autoAdvanceMissedFollowups().catch(err => console.error('[ShipMaxx autoAdvanceMissedFollowups error]:', err.message));

      const orderStrIds = delivered.map(o => String(o._id));
      const leadIds = delivered.map(o => o.lead_id).filter(Boolean);
      const createdByIds = delivered.map(o => o.created_by).filter(Boolean);

      const cleanPhones = delivered
        .map(o => String(o.billing_phone || '').replace(/\D/g, '').slice(-10))
        .filter(p => p.length === 10);
      const uniquePhones = [...new Set(cleanPhones)];
      const phoneVariants = uniquePhones.flatMap(p => [p, `+91${p}`, `91${p}`, `0${p}`]);

      const [allFollowups, leads, historicalOrders, verifications] = await Promise.all([
        Followup.find({ order_id: { $in: orderStrIds } })
          .select('order_id followup_number scheduled_date followup_date completed completed_at relief_percentage notes note auto_message_sent staff')
          .sort({ followup_number: 1 }).lean(),
        leadIds.length > 0
          ? Lead.find({ _id: { $in: leadIds } }).select('_id phone problem assignedTo createdBy status note').lean()
          : [],
        Order.find({ platform: 'shipmaxx', status: { $in: ['DELIVERED', 'delivered', 'DEL', 'del'] }, billing_phone: { $in: phoneVariants } })
          .select('_id billing_phone delivered_at status_updated_at createdAt').lean(),
        leadIds.length > 0
          ? Verification.find({ lead: { $in: leadIds } }).select('lead problem notes createdAt').sort({ createdAt: -1 }).lean()
          : []
      ]);

      const fuMap = {};
      for (const fu of allFollowups) {
        const key = String(fu.order_id);
        if (!fuMap[key]) fuMap[key] = [];
        fuMap[key].push(fu);
      }

      const leadMap = {};
      for (const l of leads) leadMap[String(l._id)] = l;

      const verifMap = {};
      for (const v of verifications) {
        const lId = String(v.lead);
        if (!verifMap[lId]) verifMap[lId] = v;
      }

      const phoneHistory = {};
      for (const ho of historicalOrders) {
        const raw = String(ho.billing_phone || '').replace(/\D/g, '');
        const p10 = raw.slice(-10);
        if (!phoneHistory[p10]) phoneHistory[p10] = [];
        phoneHistory[p10].push(ho);
      }
      const kitMap = {};
      for (const p in phoneHistory) {
        const list = phoneHistory[p];
        list.sort((a, b) => new Date(a.delivered_at || a.status_updated_at || a.createdAt) - new Date(b.delivered_at || b.status_updated_at || b.createdAt));
        list.forEach((ho, index) => {
          kitMap[String(ho._id)] = index + 1;
        });
      }

      const leadUserIds = leads.flatMap(l => [l.assignedTo, l.createdBy]).filter(Boolean);
      const supportUserIds = [
        ...delivered.map(o => o.support_staff).filter(Boolean),
        ...allFollowups.map(f => f.staff).filter(Boolean)
      ];
      const allUserIds = [...new Set([...createdByIds, ...leadUserIds, ...supportUserIds])];
      const users = allUserIds.length > 0 ? await User.find({ _id: { $in: allUserIds } }).select('_id name role email departments').lean() : [];
      const userMap = {};
      for (const u of users) userMap[String(u._id)] = u;

      const enriched = delivered.map(o => {
        const lId = o.lead_id ? String(o.lead_id) : null;
        const leadObj = lId ? leadMap[lId] : null;
        const verif = lId ? verifMap[lId] : null;
        const createdByUser = o.created_by ? userMap[String(o.created_by)] : null;
        const orderSupport = o.support_staff ? userMap[String(o.support_staff)] || null : null;
        const dept = o.department || detectOrderDepartment(o);

        let populatedLead = null;
        if (leadObj) {
          populatedLead = {
            ...leadObj,
            assignedTo: leadObj.assignedTo ? userMap[String(leadObj.assignedTo)] || leadObj.assignedTo : null,
            createdBy: leadObj.createdBy ? userMap[String(leadObj.createdBy)] || leadObj.createdBy : null,
          };
        }

        const mappedFollowups = (fuMap[String(o._id)] || []).map(fu => ({
          ...fu,
          staff: fu.staff ? userMap[String(fu.staff)] || fu.staff : (orderSupport || null)
        }));

        return {
          ...o,
          department: dept,
          support_staff: orderSupport,
          lead_id: populatedLead,
          created_by: createdByUser || o.created_by,
          followups: mappedFollowups,
          verification_problem: verif?.problem || '',
          verification_notes: (verif?.notes || []).map(n => n.text).join('\n') || '',
          kit_number: kitMap[String(o._id)] || 1
        };
      });

      followupCacheData = enriched;
      followupCacheTime = Date.now();
      return enriched;
    } finally {
      followupPendingPromise = null;
    }
  })();

  const rawData = await (followupCacheData || followupPendingPromise);
  let data = rawData || [];
  if (req.user?.role === 'support') {
    const uid = String(req.user._id);
    const userDepts = req.user.departments || [];
    data = data.filter(o => {
      const assignedId = o.support_staff?._id || o.support_staff || o.followups?.find(f => !f.completed)?.staff?._id || o.followups?.find(f => !f.completed)?.staff;
      if (String(assignedId) !== uid) return false;
      const dept = o.department || detectOrderDepartment(o);
      return isDeptMatch(userDepts, dept);
    });
  }
  res.json(new ApiResponse(200, data, 'Orders with follow-ups fetched'));
});

export const autoAdvanceFollowupsEndpoint = catchAsync(async (req, res) => {
  const result = await autoAdvanceMissedFollowups();
  invalidateFollowupCache();
  res.json(new ApiResponse(200, result, 'Missed follow-ups automatically advanced to their next call stage'));
});

export const autoAssignFollowups = catchAsync(async (req, res) => {
  const result = await distributeUnassignedFollowupsEqually();
  invalidateFollowupCache();
  res.json(new ApiResponse(200, result, 'Follow-ups distributed equally among active support staff'));
});

export const assignSupportToOrder = catchAsync(async (req, res) => {
  const { id } = req.params;
  const { staffId } = req.body;
  if (!staffId) return res.status(400).json(new ApiResponse(400, null, 'staffId is required'));

  const staffUser = await User.findOne({ _id: staffId, role: 'support', isDeleted: { $ne: true } });
  if (!staffUser) {
    return res.status(400).json(new ApiResponse(400, null, 'Selected user is not in the Support team (role: support)'));
  }

  await Promise.all([
    Order.findByIdAndUpdate(id, { support_staff: staffId }),
    Followup.updateMany({ order_id: id }, { $set: { staff: staffId } })
  ]);

  invalidateFollowupCache();
  res.json(new ApiResponse(200, { success: true }, 'Support staff assigned successfully'));
});

export const getSupportStaffList = catchAsync(async (req, res) => {
  const supportUsers = await User.find({ role: 'support', isDeleted: { $ne: true } })
    .select('_id name email phone departments lastFollowupAssignedAt')
    .sort({ name: 1 })
    .lean();

  const activeCheckedInUserIds = await getTodayActiveSupportUserIds(supportUsers.map(u => u._id));
  const enriched = supportUsers.map(u => ({
    ...u,
    isPresentToday: activeCheckedInUserIds.has(String(u._id))
  }));
  
  res.json(new ApiResponse(200, enriched, 'Support staff list fetched'));
});

export const completeFollowUp = catchAsync(async (req, res) => {
  const { id } = req.params;
  const total = DEFAULT_FOLLOWUP_TOTAL;
  const gap = DEFAULT_FOLLOWUP_GAP_DAYS;

  const count = await Followup.countDocuments({ order_id: id });
  if (count === 0) {
    const order = await Order.findById(id).select('delivered_at createdAt platform').lean();
    if (!order || order.platform !== 'shipmaxx') return res.status(404).json(new ApiResponse(404, null, 'Order not found'));
    await setAutoFollowUps(id, order.delivered_at || order.createdAt || new Date());
  }

  const current = await Followup.findOne({ order_id: id, completed: false }).sort({ followup_number: 1 });
  if (!current) {
    await Order.findByIdAndUpdate(id, { followup_done: true });
    return res.json(new ApiResponse(200, { completedCount: total, next_follow_up: null }, 'All follow-ups done'));
  }

  current.completed = true;
  current.status = 'completed';
  current.staff = req.user?._id;
  current.followup_date = new Date();
  current.completed_at = new Date();

  if (req.body?.note) { current.note = req.body.note; current.notes = req.body.note; }
  if (current.followup_number >= total) await Order.findByIdAndUpdate(id, { followup_done: true });
  await current.save();

  // Shift remaining followups
  const remaining = await Followup.find({ order_id: id, completed: false }).sort({ followup_number: 1 });
  let nextDate = null;
  if (remaining.length > 0) {
    let base = new Date();
    for (const fu of remaining) {
      base = new Date(base.getTime() + gap * 24 * 60 * 60 * 1000);
      fu.scheduled_date = new Date(base);
      await fu.save();
    }
    nextDate = remaining[0].scheduled_date;
  }

  await Order.findByIdAndUpdate(id, { next_follow_up: nextDate });
  invalidateFollowupCache();
  res.json(new ApiResponse(200, { completedCount: current.followup_number, next_follow_up: nextDate, total_followups: total, followup_gap_days: gap }, 'Follow-up completed'));
});

export const getCompletedFollowUps = catchAsync(async (req, res) => {
  const { search, page = 1, per_page = 20 } = req.query;
  const match = { platform: 'shipmaxx', status: /^(delivered|del)$/i, followup_done: true };
  if (req.user?.role === 'support') {
    match.support_staff = req.user._id;
  }
  if (search && search.trim()) {
    const s = search.trim();
    match.$or = [
      { billing_customer_name: { $regex: s, $options: 'i' } },
      { billing_phone: { $regex: s, $options: 'i' } },
      { order_id: { $regex: s, $options: 'i' } },
      { awb_code: { $regex: s, $options: 'i' } },
    ];
  }

  const skip = (Number(page) - 1) * Number(per_page);
  const [orders, total] = await Promise.all([
    Order.find(match)
      .select('-raw_response')
      .populate({ path: 'lead_id', select: 'assignedTo createdBy status problem note', populate: [{ path: 'assignedTo', select: 'name role' }, { path: 'createdBy', select: 'name role' }] })
      .sort({ delivered_at: -1 }).skip(skip).limit(Number(per_page)).lean(),
    Order.countDocuments(match),
  ]);

  if (!orders || orders.length === 0) {
    return res.json(new ApiResponse(200, { data: [], total: 0, page: Number(page), per_page: Number(per_page) }, 'Completed follow-ups fetched'));
  }

  const orderIds = orders.map(o => o._id);
  const unlinkedPhones = orders
    .filter(o => !o.lead_id)
    .map(o => String(o.billing_phone || '').replace(/\D/g, '').slice(-10))
    .filter(p => p.length === 10);
  const uniqueUnlinkedPhones = [...new Set(unlinkedPhones)];
  const unlinkedPhoneVariants = uniqueUnlinkedPhones.flatMap(p => [p, `+91${p}`, `91${p}`, `0${p}`]);

  const [allFollowups, unlinkedLeads, kitMap] = await Promise.all([
    Followup.find({ order_id: { $in: orderIds } }).sort({ followup_number: 1 }).lean(),
    uniqueUnlinkedPhones.length > 0
      ? Lead.find({ phone: { $in: unlinkedPhoneVariants } }).select('_id phone problem').lean()
      : [],
    getKitNumbersMap(orders, Order)
  ]);

  const fuMap = {};
  for (const fu of allFollowups) {
    const key = String(fu.order_id);
    if (!fuMap[key]) fuMap[key] = [];
    fuMap[key].push(fu);
  }

  const unlinkedLeadMap = {};
  for (const l of unlinkedLeads) {
    const p10 = String(l.phone || '').replace(/\D/g, '').slice(-10);
    if (p10) unlinkedLeadMap[p10] = l;
  }

  const linkedLeadIds = orders.map(o => o.lead_id?._id).filter(Boolean);
  const allLeadIds = [...linkedLeadIds, ...unlinkedLeads.map(l => l._id)];

  const verifications = allLeadIds.length > 0
    ? await Verification.find({ lead: { $in: allLeadIds } }).select('lead problem notes createdAt').sort({ createdAt: -1 }).lean()
    : [];

  const verifMap = {};
  for (const v of verifications) {
    const lId = String(v.lead);
    if (!verifMap[lId]) verifMap[lId] = v; // keep the latest one
  }

  const enriched = orders.map(o => {
    let lId = o.lead_id?._id;
    if (!lId) {
      const cleanPhone = String(o.billing_phone || '').replace(/\D/g, '').slice(-10);
      const matchedLead = unlinkedLeadMap[cleanPhone];
      if (matchedLead) lId = matchedLead._id;
    }
    const verif = lId ? verifMap[String(lId)] : null;
    return {
      ...o,
      followups: fuMap[String(o._id)] || [],
      verification_problem: verif?.problem || '',
      verification_notes: (verif?.notes || []).map(n => n.text).join('\n') || '',
      kit_number: kitMap[String(o._id)] || 1
    };
  });
  res.json(new ApiResponse(200, { data: enriched, total, page: Number(page), per_page: Number(per_page) }, 'Completed follow-ups fetched'));
});

export const addFollowUp = catchAsync(async (req, res) => {
  const { id } = req.params;
  const { note, next_follow_up, status = 'scheduled' } = req.body;
  const existing = await Followup.countDocuments({ order_id: id });
  await Followup.create({
    order_id: id,
    followup_number: existing + 1,
    scheduled_date: next_follow_up ? new Date(next_follow_up) : new Date(),
    followup_date: status === 'completed' ? new Date() : undefined,
    staff: status === 'completed' ? req.user?._id : undefined,
    status,
    note: note || '',
    notes: note || '',
    completed: status === 'completed',
    completed_at: status === 'completed' ? new Date() : undefined,
  });
  const order = await Order.findByIdAndUpdate(id, { ...(next_follow_up ? { next_follow_up: new Date(next_follow_up) } : {}) }, { returnDocument: 'after' }).select('next_follow_up').lean();
  invalidateFollowupCache();
  res.json(new ApiResponse(200, order, 'Follow up added'));
});

export const setNextFollowUp = catchAsync(async (req, res) => {
  const order = await Order.findByIdAndUpdate(req.params.id, { next_follow_up: req.body.next_follow_up ? new Date(req.body.next_follow_up) : null }, { returnDocument: 'after' }).select('next_follow_up').lean();
  invalidateFollowupCache();
  res.json(new ApiResponse(200, order, 'Next follow up set'));
});

export const updateFollowupRelief = catchAsync(async (req, res) => {
  const { followup_number, relief_percentage } = req.body;
  if (!followup_number || relief_percentage === undefined)
    return res.status(400).json(new ApiResponse(400, null, 'followup_number and relief_percentage required'));
  const fu = await Followup.findOneAndUpdate(
    { order_id: req.params.id, followup_number: Number(followup_number) },
    { $set: { relief_percentage: Number(relief_percentage) } },
    { returnDocument: 'after' }
  );
  if (!fu) return res.status(404).json(new ApiResponse(404, null, 'Followup not found'));
  invalidateFollowupCache();
  res.json(new ApiResponse(200, fu, 'Relief percentage updated'));
});

// ── Order Activity & Contact ──────────────────────────────────────────────────
export const getOrderActivity = catchAsync(async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, platform: 'shipmaxx' })
    .select('comments notes order_id billing_customer_name status createdAt')
    .populate('comments.createdBy', 'name role').lean();
  if (!order) return res.status(404).json(new ApiResponse(404, null, 'Order not found'));
  const activity = (order.comments || [])
    .filter(c => !c.text?.startsWith('[WhatsApp Reply]'))
    .map(c => ({
      _id: c._id,
      type: c.type || 'general',
      title: c.type === 'followup' ? 'Follow-up Note' : 'Note Added',
      description: c.text || '',
      actor: c.createdBy,
      createdAt: c.createdAt,
    }));
  res.json(new ApiResponse(200, activity, 'Activity fetched'));
});

export const updateOrderContact = catchAsync(async (req, res) => {
  const { id } = req.params;
  const allowed = ['billing_phone', 'billing_city', 'billing_state', 'billing_pincode', 'billing_address'];
  const update = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) update[key] = String(req.body[key]).trim();
  }
  if (!Object.keys(update).length) return res.status(400).json(new ApiResponse(400, null, 'No valid fields'));
  const orderDoc = await Order.updateWithTransaction({ _id: id, platform: 'shipmaxx' }, { $set: update }, { returnDocument: 'after' });
  if (!orderDoc) return res.status(404).json(new ApiResponse(404, null, 'Order not found'));

  if (orderDoc.lead_id) {
    const leadUpdate = {};
    if (update.billing_phone) leadUpdate.phone = update.billing_phone;
    if (update.billing_city) leadUpdate.cityVillage = update.billing_city;
    if (update.billing_state) leadUpdate.state = update.billing_state;
    if (update.billing_pincode) leadUpdate.pincode = update.billing_pincode;
    if (update.billing_address) leadUpdate.address = update.billing_address;
    if (Object.keys(leadUpdate).length) await Lead.findByIdAndUpdate(orderDoc.lead_id, { $set: leadUpdate });
  }

  // Create a selected object to match previous .select().lean() behavior
  const orderObj = orderDoc.toObject ? orderDoc.toObject() : orderDoc;
  const selectedOrder = { _id: orderObj._id, lead_id: orderObj.lead_id };
  for (const key of allowed) {
    selectedOrder[key] = orderObj[key];
  }

  invalidateFollowupCache();
  res.json(new ApiResponse(200, selectedOrder, 'Contact updated'));
});

// ── Search by phone (for order creation auto-fill) ────────────────────────────
export const searchOrderByPhone = catchAsync(async (req, res) => {
  const { phone } = req.query;
  if (!phone || phone.replace(/\D/g, '').length < 5) return res.json(new ApiResponse(200, null, 'No result'));
  const clean = phone.replace(/\D/g, '');
  const last10 = clean.slice(-10);

  let order = await Order.findOne({
    platform: 'shipmaxx',
    $or: [{ billing_phone: { $regex: last10 } }, { billing_phone: { $regex: clean } }]
  }).sort({ createdAt: -1 }).lean();

  let lead = await leadService.findLeadByPhone(last10);

  if (!order && lead) {
    order = {
      billing_customer_name: lead.name || '',
      billing_phone: lead.phone || '',
      billing_email: lead.email || '',
      billing_address: lead.address || '',
      billing_city: lead.cityVillage || lead.district || '',
      billing_state: lead.state || '',
      billing_pincode: lead.pincode || '',
      sub_total: 0,
      order_items: [],
    };
  }
  if (!order) return res.json(new ApiResponse(200, null, 'Not found'));

  const activeLead = lead;
  if (activeLead) {
    if (!order.billing_customer_name) order.billing_customer_name = activeLead.name || '';
    if (!order.billing_address) order.billing_address = activeLead.address || '';
    if (!order.billing_pincode) order.billing_pincode = activeLead.pincode || '';
    if (!order.billing_city) order.billing_city = activeLead.cityVillage || activeLead.district || '';
    if (!order.billing_state) order.billing_state = activeLead.state || '';
    if (!order.billing_email) order.billing_email = activeLead.email || '';
  }

  res.json(new ApiResponse(200, {
    billing_customer_name: order.billing_customer_name || '',
    billing_phone: order.billing_phone || clean,
    billing_email: order.billing_email || '',
    billing_address: order.billing_address || '',
    billing_city: order.billing_city || '',
    billing_state: order.billing_state || '',
    billing_pincode: String(order.billing_pincode || ''),
    order_items: order.order_items || [],
    sub_total: order.sub_total || 0,
    delivered_at: order.delivered_at || null,
    order_id: order.order_id || '',
    courier_name: order.courier_name || '',
    payment_method: order.payment_method || '',
  }, 'Order found'));
});

// ── Send to Verification ──────────────────────────────────────────────────────
export const sendToVerification = catchAsync(async (req, res) => {
  const { id } = req.params;
  const { source, notes, problem, medicine, price } = req.body || {};
  const order = await Order.findOne({ _id: id, platform: 'shipmaxx' }).populate('lead_id');
  if (!order) return res.status(404).json(new ApiResponse(404, null, 'Order not found'));

  let lead = order.lead_id;
  const orderPhone = order.billing_phone ? String(order.billing_phone).replace(/\D/g, '') : '';
  const leadPhone = lead?.phone ? String(lead.phone).replace(/\D/g, '') : '';

  // If lead is missing or phone numbers don't match, find/create the correct lead by order phone
  if (!lead || (orderPhone && leadPhone && orderPhone.slice(-10) !== leadPhone.slice(-10))) {
    if (orderPhone && orderPhone.length >= 10) {
      lead = await leadService.findLeadByPhone(orderPhone.slice(-10));
    }
    if (!lead) {
      lead = await Lead.create({
        name: order.billing_customer_name || 'Unknown Customer',
        phone: order.billing_phone || 'N/A',
        address: order.billing_address || '',
        status: 'follow_up',
        createdBy: req.user._id,
      });
    }
    await Order.findByIdAndUpdate(id, { lead_id: lead._id });
  }

  // Ensure Lead name matches order customer name if lead name is generic/missing
  if (order.billing_customer_name && (!lead.name || lead.name === 'Unknown Customer' || lead.name === 'N/A')) {
    await Lead.findByIdAndUpdate(lead._id, { name: order.billing_customer_name });
    lead.name = order.billing_customer_name;
  }

  const followups = await Followup.find({ order_id: id }).sort({ followup_number: 1 }).lean();
  const lastRelief = [...followups].reverse().find(f => f.relief_percentage != null)?.relief_percentage ?? null;

  let oldVer = null;
  if (order.verification_id) {
    oldVer = await Verification.findById(order.verification_id);
  }

  const isAddon = source === 'add_on';
  const customerName = order.billing_customer_name || lead.name || 'Unknown Customer';
  const titlePrefix = source === 'rto' ? '[RTO] Re-Verification for ' : (isAddon ? '[Add-on] Re-Verification for ' : 'Re-Verification for ');
  const itemMedicineName = order.order_items?.[0]?.name || '';
  const fallbackProblem = problem || (isAddon && medicine ? `Add-on Medicine: ${medicine}` : '') || order.verification_problem || order.problem || lead.problem || oldVer?.problem || itemMedicineName || '';
  const finalPrice = (price !== undefined && price !== null && price !== '') ? Number(price) : (order.sub_total || 0);

  const task = await Task.create({
    title: `${titlePrefix}${customerName}`,
    lead: lead._id,
    assignedTo: req.user._id,
    createdBy: req.user._id,
    status: 'verification',
    dueDate: new Date(),
    cityVillage: order.billing_city || lead.cityVillage || '',
    state: order.billing_state || lead.state || '',
    pincode: order.billing_pincode || lead.pincode || '',
    address: order.billing_address || lead.address || '',
    phone: order.billing_phone || lead.phone || '',
    price: finalPrice,
    problem: fallbackProblem,
    department: lead.department || oldVer?.department || 'migraine',
  });

  const addonText = [
    medicine ? `Add-on Product: ${medicine}` : null,
    notes ? `Notes: ${notes}` : null
  ].filter(Boolean).join(' | ');

  const verificationNotes = [];
  if (oldVer?.notes) verificationNotes.push(...oldVer.notes);
  if (addonText) verificationNotes.push({ text: `[Add-on Order] ${addonText}`, createdBy: req.user._id, createdAt: new Date() });

  await Verification.create({
    task: task._id,
    title: task.title,
    assignedTo: task.assignedTo,
    lead: task.lead,
    dueDate: task.dueDate,
    cityVillage: task.cityVillage,
    state: task.state,
    pincode: task.pincode,
    address: task.address,
    problem: fallbackProblem,
    age: oldVer?.age,
    weight: oldVer?.weight,
    height: oldVer?.height,
    otherProblems: oldVer?.otherProblems,
    problemDuration: oldVer?.problemDuration,
    department: lead.department || oldVer?.department || 'migraine',
    price: finalPrice,
    relief_percentage: lastRelief,
    notes: verificationNotes,
  });

  const updatePayload = { followup_done: true, sent_to_verification: true, verified_by: req.user._id };
  if (source === 'rto') {
    updatePayload.rto_verification_action = 'send_to_verification';
  }
  if (notes) {
    await Order.findByIdAndUpdate(id, { $push: { comments: { text: `[Verification ${isAddon ? 'Add-on' : 'Re-order'}] ${notes}`, type: 'general', createdBy: req.user._id } } });
  }
  await Order.findByIdAndUpdate(id, updatePayload);
  await Lead.findByIdAndUpdate(lead._id, { $set: { pending_reorder_source: id, pending_reorder_staff: req.user._id } });

  // ── Commission Chain: Lock submitter ID for this Shipmaxx repeat order ───────────
  // This is step 4 of the commission workflow: the moment a repeat order is submitted
  // for verification, req.user._id is frozen as the submitter for this chain entry.
  // appendOrderChain detects the first-order chain entry and fires the 50-50 split.
  try {
    await appendOrderChain({
      leadId: lead._id,
      orderId: id,                   // the ShipmaxxOrder being re-verified
      orderModel: 'ShipmaxxOrder',
      submitterId: req.user._id,         // LOCKED — current submitter identity
      orderType: 'repeat',             // Shipmaxx sendToVerification is always a repeat
      orderSubTotal: order.sub_total || 0,
      actor: req.user,
    });
  } catch (chainErr) {
    // Commission chain errors must not block the verification submission.
    console.error('[OrderChain] Shipmaxx sendToVerification chain entry failed:', chainErr.message);
  }

  invalidateFollowupCache();
  res.json(new ApiResponse(200, task, 'Order sent to verification successfully'));
});

// ── Manual Followup ───────────────────────────────────────────────────────────
export const createManualFollowup = catchAsync(async (req, res) => {
  const { name, phone, city, state, medicine, delivered_date, amount, order_id, courier_name, payment_method, pincode, address, kit_number, department } = req.body;
  if (!name || !phone || !medicine || !delivered_date)
    return res.status(400).json(new ApiResponse(400, null, 'name, phone, medicine, delivered_date are required'));

  const mockOrderId = order_id ? `${order_id}-M${Date.now()}` : `SMX-MANUAL-${Date.now()}`;
  const d = new Date(delivered_date);

  const finalKitNum = Number(kit_number) || 1;
  const tempOrder = {
    order_items: [{ name: medicine }],
    notes: medicine,
    department: department || undefined
  };
  const targetDept = department || detectOrderDepartment(tempOrder);

  // Assign support staff
  let assignedStaff = null;
  if (req.user && req.user.role === 'support') {
    assignedStaff = req.user._id;
  } else {
    assignedStaff = await getNextSupportUser(targetDept, d);
  }

  const newOrder = await Order.create({
    order_id: mockOrderId,
    status: 'DELIVERED',
    delivered_at: d,
    billing_customer_name: name,
    billing_phone: phone,
    billing_city: city || '',
    billing_state: state || '',
    billing_pincode: pincode || '',
    billing_address: address || '',
    sub_total: Number(amount) || 0,
    order_items: [{ name: medicine }],
    courier_name: courier_name || '',
    payment_method: payment_method || '',
    platform: 'shipmaxx',
    created_by: req.user._id,
    support_staff: assignedStaff || req.user._id,
    kit_number: finalKitNum,
    department: targetDept,
    auto_followups_set: true,
  });

  const total = DEFAULT_FOLLOWUP_TOTAL;
  const gap = DEFAULT_FOLLOWUP_GAP_DAYS;
  const followups = [];
  let baseDate = new Date();
  for (let i = 1; i <= total; i++) {
    if (i > 1) baseDate.setDate(baseDate.getDate() + gap);
    followups.push({
      order_id: newOrder._id,
      followup_number: i,
      scheduled_date: new Date(baseDate),
      status: 'scheduled',
      note: '',
      staff: assignedStaff || req.user._id
    });
  }
  const insertedFollowups = await Followup.insertMany(followups);

  invalidateFollowupCache();

  const populatedOrder = await Order.findById(newOrder._id).populate('support_staff', 'name email role departments').lean();
  if (populatedOrder) {
    populatedOrder.followups = insertedFollowups;
  }

  res.json(new ApiResponse(200, populatedOrder || newOrder, 'Manual followup added successfully'));
});

// Temporarily adding a cleanup endpoint to remove Shiprocket duplicates
import { Order as ShiprocketOrder } from '../shiprocket/models/order.model.js';
export const cleanupDuplicates = catchAsync(async (req, res) => {
  const srOrders = await ShiprocketOrder.find({}).select('awb_code order_id').lean();
  const srAwbs = srOrders.map(o => o.awb_code).filter(Boolean);
  const srIds = srOrders.map(o => o.order_id).filter(Boolean);

  if (srAwbs.length === 0 && srIds.length === 0) {
    return res.json(new ApiResponse(200, { deleted: 0 }, 'No Shiprocket data found'));
  }

  const query = { $or: [] };
  if (srAwbs.length > 0) query.$or.push({ awb_code: { $in: srAwbs } });
  if (srIds.length > 0) query.$or.push({ order_id: { $in: srIds } });

  const overlap = await Order.find(query).lean();
  if (overlap.length > 0) {
    const result = await Order.deleteMany(query);
    return res.json(new ApiResponse(200, { found: overlap.length, deleted: result.deletedCount }, 'Cleaned up overlapping records'));
  }

  res.json(new ApiResponse(200, { deleted: 0 }, 'No overlapping orders found in ShipMaxx DB'));
});

export const debugBackfillDelivered = catchAsync(async (req, res) => {
  const orders = await Order.find({ platform: 'shipmaxx', status: { $in: [/^delivered$/i, /^rto_delivered$/i, /^DEL$/i, /^RTO$/i] }, delivered_at: { $exists: false } }).limit(500);
  let fixed = 0;
  for (const o of orders) {
    try {
      const trackRes = await smx.trackShipment(o.awb_code);
      const tracking = trackRes?.data?.data || trackRes?.data || trackRes || {};
      let actualDeliveredAt = null;
      if (tracking.history && Array.isArray(tracking.history)) {
        const delEvent = tracking.history.find(h => {
          const c = h.system_status_code || '';
          const n = (h.system_status_name || '').toLowerCase();
          const s = (h.status || '').toLowerCase();
          return c === 'DEL' || c === 'RTO' || n.includes('delivered') || s.includes('delivered') || n.includes('rto') || s.includes('rto');
        });
        if (delEvent) {
          const dStr = delEvent.date || delEvent.timestamp || delEvent.time;
          if (dStr) {
            const pd = parseShipMaxxDate(dStr);
            if (pd && !isNaN(pd.getTime())) actualDeliveredAt = pd;
          }
        }
      }

      // If we couldn't find a DEL or RTO event, just use the last updated date if it's not today.
      // If it IS today, use the created date + 3 days to avoid spiking "Today's Delivered".
      if (!actualDeliveredAt) {
        const now = new Date();
        const isToday = o.status_updated_at && o.status_updated_at.toDateString() === now.toDateString();
        if (o.status_updated_at && !isToday) {
          actualDeliveredAt = o.status_updated_at;
        } else {
          actualDeliveredAt = new Date(o.createdAt.getTime() + 3 * 24 * 60 * 60 * 1000);
        }
      }

      if (actualDeliveredAt) {
        o.delivered_at = actualDeliveredAt;
        o.status_updated_at = actualDeliveredAt;
        await o.save();
        fixed++;
      }
    } catch (err) {
      console.error(err);
    }
  }
  res.json({ checked: orders.length, fixed });
});

export const readReply = catchAsync(async (req, res) => {
  const { id } = req.params;
  const order = await Order.findByIdAndUpdate(id, { interakt_reply_read: true }, { new: true });
  if (!order) return res.status(404).json(new ApiResponse(404, null, 'Order not found'));
  res.json(new ApiResponse(200, order, 'Reply marked as read'));
});

/**
 * ShipMaxx Webhook Handler
 * ShipMaxx calls this URL when order status changes.
 * Set this URL in ShipMaxx panel: https://yourdomain.com/webhook/shipmaxx
 *
 * Expected payload fields (ShipMaxx may vary):
 *   awb, order_id, status (or current_status), timestamp
 */
export const shipmaxxWebhook = catchAsync(async (req, res) => {
  // Acknowledge immediately so ShipMaxx doesn't retry
  res.json({ success: true });

  const payload = req.body;
  console.log('[ShipMaxx Webhook] Received:', JSON.stringify(payload).substring(0, 300));

  // Support nested payloads (e.g. payload.data, payload.shipment, payload.order)
  const p = payload.data || payload.shipment || payload.order || payload;

  // Extract fields — ShipMaxx uses various field names
  const rawStatus = p.status || p.current_status || p.shipment_status || p.delivery_status || '';
  const awb = p.awb || p.awb_code || p.tracking_number || '';
  const orderId = p.order_id ? String(p.order_id) : '';
  const phone = p.phone || p.customer_phone || p.billing_phone || '';
  const name = p.customer_name || p.name || '';
  const eventDate = p.timestamp || p.updated_at || p.date ? new Date(p.timestamp || p.updated_at || p.date) : new Date();

  if (!rawStatus || (!awb && !orderId)) {
    console.log('[ShipMaxx Webhook] Missing status/awb/orderId — ignoring');
    return;
  }

  const status = normalizeShipmaxxStatus(rawStatus);

  // Find existing order
  const query = [];
  if (orderId) query.push({ order_id: orderId, platform: 'shipmaxx' });
  if (awb) query.push({ awb_code: awb, platform: 'shipmaxx' });
  if (!query.length) return;

  const existing = await Order.findOne({ $or: query }).lean();

  const update = { status_updated_at: eventDate };
  if (awb) update.awb_code = awb;
  if (phone && !existing?.billing_phone) update.billing_phone = phone;
  if (name && !existing?.billing_customer_name) update.billing_customer_name = name;

  // Attempt & NDR mapping matching logic
  let finalStatus = status;
  const ndrKw = ['EXCEPTION', 'REFUSED', 'NOT AVAILABLE', 'INCOMPLETE', 'ACTION TAKEN', 'ATTEMPT FAILURE', 'ADDRESS'];
  if (status === 'UNDELIVERED' || status === 'UNDELIVERED_ATTEMPT_FAILURE' || status === 'UNDELIVERED_FAILURE' || (ndrKw.some(k => status.includes(k)) && !status.includes('DELIVERED'))) {
    const attempt = Number(p.attempt_number || p.attemptNumber || p.attempt_count || p.attemptCount || (existing ? existing.delivery_attempt : 1)) || 1;
    finalStatus = attempt === 1 ? 'UNDELIVERED_1ST_ATTEMPT' : attempt === 2 ? 'UNDELIVERED_2ND_ATTEMPT' : attempt === 3 ? 'UNDELIVERED_3RD_ATTEMPT' : 'UNDELIVERED';
    update.delivery_attempt = attempt;
  }

  const protectedStatuses = ['DELIVERED', 'RTO_DELIVERED'];
  if (!existing || !protectedStatuses.includes(existing.status)) {
    update.status = finalStatus;
  }

  if (finalStatus === 'DELIVERED' || status === 'DELIVERED') {
    update.delivered_at = eventDate;
  }

  // Update order using transaction helper to keep sub-collections synced
  const updated = await Order.updateWithTransaction(
    query.length === 1 ? query[0] : { $or: query },
    { $set: update },
    { upsert: false }
  );

  if (!updated) {
    console.log('[ShipMaxx Webhook] Order not found in DB for', { orderId, awb });
    return;
  }

  // ── DELIVERED: send WhatsApp + set followups ──────────────────────────────
  if (status === 'DELIVERED' && existing?.status !== 'DELIVERED') {
    console.log('[ShipMaxx Webhook] Order newly DELIVERED:', updated.order_id);

    // Set followups if not already set — this also sends WA message
    if (!updated.auto_followups_set) {
      await setAutoFollowUps(updated._id, eventDate);
    } else {
      // Followups already set but maybe WA not sent — check and send
      const templateName = process.env.INTERAKT_1ST_FOLLOWUP_TEMPLATE;
      if (templateName && updated.billing_phone) {
        const fu1 = await Followup.findOne({ order_id: String(updated._id), followup_number: 1 })
          .select('auto_message_sent').lean();
        if (!fu1 || !fu1.auto_message_sent) {
          await Followup.findOneAndUpdate(
            { order_id: String(updated._id), followup_number: 1 },
            { $set: { auto_message_sent: true } }
          );
          sendWhatsAppMessage({
            phone: updated.billing_phone,
            templateName,
            languageCode: 'en',
            bodyValues: [updated.billing_customer_name || 'Customer']
          }).then(() => console.log(`[ShipMaxx Webhook] ✅ WA sent to ${updated.billing_phone}`))
            .catch(async (err) => {
              console.error('[ShipMaxx Webhook] WA error:', err.message);
              await Followup.findOneAndUpdate(
                { order_id: String(updated._id), followup_number: 1 },
                { $set: { auto_message_sent: false } }
              ).catch(() => { });
            });
        }
      }
    }

    // Update lead status
    if (updated.lead_id) {
      Lead.findByIdAndUpdate(updated.lead_id, { status: 'follow_up' }).catch(() => { });
    }
  }
});

// ── NDR ───────────────────────────────────────────────────────────────────────
export const getNdrList = catchAsync(async (req, res) => {
  try {
    const response = await smx.getNdrList(req.query);
    const list = response?.data?.data || response?.data || response || [];
    if (Array.isArray(list) && list.length > 0) {
      return res.json(new ApiResponse(200, response, 'NDR list fetched from Shipmaxx API'));
    }
  } catch (err) {
    console.warn('[ShipMaxx API NDR Fetch Failed, falling back to local DB]:', err.message);
  }

  // Fallback to local MongoDB NDR records
  const { from, to, page = 1, limit = 100 } = req.query;
  const match = { platform: 'shipmaxx', status: /UNDELIVERED|NDR|EXCEPTION/i };
  if (from || to) {
    match.status_updated_at = {};
    if (from) match.status_updated_at.$gte = new Date(from);
    if (to) {
      const toDate = new Date(to);
      toDate.setHours(23, 59, 59, 999);
      match.status_updated_at.$lte = toDate;
    }
  }

  const orders = await Order.find(match)
    .sort({ createdAt: -1, status_updated_at: -1, _id: -1 })
    .skip((Number(page) - 1) * Number(limit))
    .limit(Number(limit))
    .lean();

  const formatted = orders.map(o => ({
    awb_code: o.awb_code,
    channel_order_id: o.order_id,
    order_id: o.order_id,
    shipment_id: o._id,
    customer_name: o.billing_customer_name,
    customer_phone: o.billing_phone,
    courier_name: o.courier_name,
    status: o.status,
    reason: o.comments?.[0]?.text || 'Undelivered Attempt Failure',
    attempts: o.status?.includes('1ST') ? 1 : o.status?.includes('2ND') ? 2 : o.status?.includes('3RD') ? 3 : 1,
    ndr_raised_at: o.status_updated_at || o.createdAt,
    payment_method: o.payment_method,
    address: o.billing_address,
    pincode: o.billing_pincode
  }));

  res.json(new ApiResponse(200, { data: formatted, total: formatted.length }, 'NDR list fetched from database'));
});

export const ndrAction = catchAsync(async (req, res) => {
  const ndr_id = req.params.ndr_id || req.body.ndr_id || req.body.awb;
  const { action, notes } = req.body;
  if (!ndr_id) {
    return res.status(400).json(new ApiResponse(400, null, 'ndr_id or awb is required'));
  }
  if (!action) {
    return res.status(400).json(new ApiResponse(400, null, 'action is required'));
  }

  // Call external Losung API
  const response = await smx.ndrAction(ndr_id, { action, notes });

  // Log action locally in our DB
  try {
    const order = await Order.findOne({ platform: 'shipmaxx', $or: [{ order_id: ndr_id }, { awb_code: ndr_id }] });
    if (order) {
      const comment = {
        text: `[NDR Action Request] Action: ${action}. Notes: ${notes || 'None'}`,
        type: 'system',
        section: 'NDR',
        createdBy: req.user._id,
        createdAt: new Date()
      };
      await Order.updateWithTransaction(
        { _id: order._id },
        { $push: { comments: comment } }
      );
    }
  } catch (err) {
    console.error('[ShipMaxx NDR Action DB Log Error]', err.message);
  }

  res.json(new ApiResponse(200, response, 'NDR action submitted successfully'));
});

export const ndrBulkAction = catchAsync(async (req, res) => {
  const { ndr_ids, action, notes } = req.body;
  if (!ndr_ids || !Array.isArray(ndr_ids) || ndr_ids.length === 0) {
    return res.status(400).json(new ApiResponse(400, null, 'ndr_ids is required and must be an array'));
  }
  if (ndr_ids.length > 10) {
    return res.status(400).json(new ApiResponse(400, null, 'Maximum 10 NDR IDs allowed per request'));
  }
  if (!action) {
    return res.status(400).json(new ApiResponse(400, null, 'action is required'));
  }

  // Call external Losung API
  const response = await smx.ndrBulkAction({ ndr_ids, action, notes });

  // Log actions locally in our DB
  try {
    for (const ndr_id of ndr_ids) {
      const order = await Order.findOne({ platform: 'shipmaxx', $or: [{ order_id: ndr_id }, { awb_code: ndr_id }] });
      if (order) {
        const comment = {
          text: `[Bulk NDR Action Request] Action: ${action}. Notes: ${notes || 'None'}`,
          type: 'system',
          section: 'NDR',
          createdBy: req.user._id,
          createdAt: new Date()
        };
        await Order.updateWithTransaction(
          { _id: order._id },
          { $push: { comments: comment } }
        );
      }
    }
  } catch (err) {
    console.error('[ShipMaxx Bulk NDR Action DB Log Error]', err.message);
  }

  res.json(new ApiResponse(200, response, 'Bulk NDR action submitted successfully'));
});

// ── NDR Notes (DB) ────────────────────────────────────────────────────────────
export const getNdrNotes = catchAsync(async (req, res) => {
  const { date, search } = req.query;
  const match = { source: 'shipmaxx' };
  if (date) {
    match.createdAt = {
      $gte: new Date(date + 'T00:00:00.000+05:30'),
      $lte: new Date(date + 'T23:59:59.999+05:30'),
    };
  }
  if (search) {
    match.$or = [
      { name: { $regex: search, $options: 'i' } },
      { phone_number: { $regex: search, $options: 'i' } },
      { awb_number: { $regex: search, $options: 'i' } },
    ];
  }
  const notes = await NdrNote.find(match).sort({ createdAt: -1 }).populate('createdBy', 'name role').lean();
  res.json(new ApiResponse(200, notes, 'NDR notes fetched'));
});

export const createNdrNote = catchAsync(async (req, res) => {
  const { name, phone_number, reason, awb_number } = req.body;
  if (!name || !phone_number || !reason || !awb_number)
    return res.status(400).json(new ApiResponse(400, null, 'name, phone_number, reason, awb_number required'));
  const note = await NdrNote.create({ name, phone_number, reason, awb_number, source: 'shipmaxx', createdBy: req.user._id });
  res.json(new ApiResponse(200, note, 'NDR note created'));
});

export const updateNdrNote = catchAsync(async (req, res) => {
  const note = await NdrNote.findByIdAndUpdate(
    req.params.id,
    { $set: req.body },
    { returnDocument: 'after' }
  ).lean();
  if (!note) return res.status(404).json(new ApiResponse(404, null, 'Note not found'));
  res.json(new ApiResponse(200, note, 'NDR note updated'));
});

export const deleteNdrNote = catchAsync(async (req, res) => {
  await NdrNote.findByIdAndDelete(req.params.id);
  res.json(new ApiResponse(200, null, 'NDR note deleted'));
});


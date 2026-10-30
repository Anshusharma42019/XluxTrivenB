import express from 'express';
import mongoose from 'mongoose';
import auth from '../../middleware/auth.js';
import catchAsync from '../../utils/catchAsync.js';
import ApiResponse from '../../utils/ApiResponse.js';
import httpStatus from 'http-status';

import User from '../user/user.model.js';
import Lead from '../lead/lead.model.js';
import { Task } from '../task/task.model.js';
import Verification from '../verification/verification.model.js';
import ReadyToShipment from '../readytoshipment/readytoshipment.model.js';
import CallAgain from '../callagain/callagain.model.js';
import Cnp from '../cnp/cnp.model.js';
import Appointment from '../appointment/appointment.model.js';
import { Order as ShiprocketOrder } from '../shiprocket/models/order.model.js';
import { ShipmaxxOrder } from '../shipmaxx/models/shipmaxxOrder.model.js';
import {
  InterestedLead,
  NotInterestedLead,
  PendingOrder,
  OnHoldOrder,
  VerifiedOrder,
} from '../transition/statusModels.js';
// ── Commission chain ── imported lazily below to avoid circular dep issues

const getModel = (name) => {
  try { return mongoose.model(name); } catch(e) { return null; }
};

const router = express.Router();
const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

router.get('/', auth('admin', 'manager', 'sales', 'support', 'logistics'), catchAsync(async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2) {
    return res.json(new ApiResponse(httpStatus.OK, [], 'Search results'));
  }

  const queryStr = q.trim();
  const safeRegex = new RegExp(escapeRegex(queryStr), 'i');
  
  // Clean phone digits for phone search (e.g. "+91 89995 37057" -> "8999537057")
  const digitsOnly = queryStr.replace(/\D/g, '');
  const nonDigitChars = queryStr.replace(/[\d\s\+\-\(\)]/g, '');
  
  // Query is a phone search if it has >= 4 digits and no letter/symbol text
  const isPhoneQuery = digitsOnly.length >= 4 && nonDigitChars.length === 0;
  const cleanPhone = digitsOnly.length >= 10 ? digitsOnly.slice(-10) : (digitsOnly.length >= 4 ? digitsOnly : null);

  let isValidObjectId = false;
  try {
    isValidObjectId = mongoose.Types.ObjectId.isValid(queryStr) && (String(new mongoose.Types.ObjectId(queryStr)) === queryStr);
  } catch (e) {}

  const limit = 25; 

  let leadMatch;
  let orderMatch;
  let phoneReg = null;

  if (cleanPhone) {
    const phonePattern = cleanPhone.split('').join('[\\s\\-]*');
    phoneReg = new RegExp(phonePattern, 'i');
  }

  if (isPhoneQuery && cleanPhone) {
    // STRICT PHONE SEARCH: Search ONLY phone fields (or order_id/awb if digits match an order ID/AWB)
    leadMatch = { 
      isDeleted: false, 
      $or: [
        { phone: phoneReg },
        ...(isValidObjectId ? [{ _id: queryStr }] : [])
      ]
    };

    orderMatch = {
      $or: [
        { billing_phone: phoneReg },
        { order_id: safeRegex },
        { awb_code: safeRegex }
      ]
    };
  } else {
    // GENERAL SEARCH (Name, Email, Problem, Order ID, AWB Code, etc.)
    const baseMatch = { 
      $or: [
        { name: safeRegex }, 
        { email: safeRegex }, 
        { problem: safeRegex }
      ] 
    };

    if (phoneReg && digitsOnly.length >= 7) {
      baseMatch.$or.push({ phone: phoneReg });
    }
    if (isValidObjectId) baseMatch.$or.push({ _id: queryStr });

    leadMatch = { isDeleted: false, ...baseMatch };
    
    orderMatch = { 
      $or: [
        { billing_customer_name: safeRegex }, 
        { order_id: safeRegex }, 
        { awb_code: safeRegex }
      ] 
    };
    if (phoneReg && digitsOnly.length >= 7) {
      orderMatch.$or.push({ billing_phone: phoneReg });
    }

    if (digitsOnly.length >= 7) {
      try {
        const [leadPhones, orderPhones] = await Promise.all([
          Lead.find({ isDeleted: false, phone: phoneReg }).select('phone').limit(10).lean(),
          ShiprocketOrder.find({ billing_phone: phoneReg }).select('billing_phone').limit(10).lean()
        ]);
        const phoneSet = new Set();
        leadPhones.forEach(l => { if (l.phone) phoneSet.add(l.phone.replace(/\D/g, '').slice(-10)); });
        orderPhones.forEach(o => { if (o.billing_phone) phoneSet.add(o.billing_phone.replace(/\D/g, '').slice(-10)); });
        
        phoneSet.forEach(p => {
          if (p) {
            const reg = new RegExp(p.split('').join('[\\s\\-]*'), 'i');
            leadMatch.$or.push({ phone: reg });
            orderMatch.$or.push({ billing_phone: reg });
          }
        });
      } catch (err) {}
    }
  }

  // Get matching lead IDs (including transitioned/archived leads) for linked collection lookups
  const subqueryMatch = leadMatch.$or ? { $or: leadMatch.$or } : leadMatch;
  const matchedLeadsForSubqueries = await Lead.find(subqueryMatch).select('_id').lean();
  const matchedLeadIds = matchedLeadsForSubqueries.map(l => l._id);
  
  const [
    leads, 
    tasks, 
    verifications, 
    rtsRecords, 
    callAgains, 
    cnps,
    appointments,
    shiprocketOrders,
    shiprocketDelivered,
    shiprocketInTransit,
    shiprocketRto,
    shipmaxxOrders,
    shipmaxxDelivered,
    shipmaxxInTransit,
    shipmaxxRto,
    interestedLeads,
    notInterestedLeads,
    pendingOrders,
    onHoldOrders,
    verifiedOrders
  ] = await Promise.all([
    Lead.find(leadMatch).populate('assignedTo', 'name role').sort({ updatedAt: -1 }).limit(limit).lean(),
    Task.find({ $or: [{ title: safeRegex, isDeleted: false }, { phone: safeRegex }, { lead: { $in: matchedLeadIds } }, ...(cleanPhone ? [{ phone: new RegExp(cleanPhone) }] : [])] }).populate('assignedTo', 'name role').populate('createdBy', 'name role').populate({ path: 'lead', select: 'name phone problem department address cityVillage state pincode', strictPopulate: false }).sort({ updatedAt: -1 }).limit(limit).lean(),
    Verification.find({ $or: [{ title: safeRegex, isDeleted: false }, { phone: safeRegex }, { lead: { $in: matchedLeadIds } }, ...(cleanPhone ? [{ phone: new RegExp(cleanPhone) }] : [])] }).populate('assignedTo', 'name role').populate('verifiedBy', 'name role').populate({ path: 'lead', select: 'name phone problem department address cityVillage state pincode', strictPopulate: false }).sort({ updatedAt: -1 }).limit(limit).lean(),
    ReadyToShipment.find({ $or: [{ title: safeRegex, isDeleted: false }, { phone: safeRegex }, { lead: { $in: matchedLeadIds } }, ...(cleanPhone ? [{ phone: new RegExp(cleanPhone) }] : [])] }).populate({ path: 'lead', select: 'name phone problem department address cityVillage state pincode', strictPopulate: false }).populate('assignedTo', 'name role').sort({ updatedAt: -1 }).limit(limit).lean(),
    CallAgain.find({ isDeleted: false, $or: [{ lead: { $in: matchedLeadIds } }, { phone: safeRegex }, ...(cleanPhone ? [{ phone: new RegExp(cleanPhone) }] : [])] }).populate({ path: 'lead', select: 'name phone problem department address cityVillage state pincode', strictPopulate: false }).populate('assignedTo', 'name role').sort({ updatedAt: -1 }).limit(limit).lean(),
    Cnp.find({ isDeleted: false, $or: [{ lead: { $in: matchedLeadIds } }, { phone: safeRegex }, ...(cleanPhone ? [{ phone: new RegExp(cleanPhone) }] : [])] }).populate({ path: 'lead', select: 'name phone problem department address cityVillage state pincode', strictPopulate: false }).populate('assignedTo', 'name role').sort({ updatedAt: -1 }).limit(limit).lean(),
    Appointment.find({ isDeleted: false, $or: [{ patientName: safeRegex }, { phone: safeRegex }, ...(cleanPhone ? [{ phone: new RegExp(cleanPhone) }] : [])] }).populate('createdBy', 'name role').sort({ updatedAt: -1 }).limit(limit).lean(),
    
    ShiprocketOrder.find(orderMatch)
      .populate({ path: 'lead_id', populate: { path: 'assignedTo', select: 'name role' }, strictPopulate: false })
      .populate({ path: 'verification_id', populate: [{ path: 'assignedTo', select: 'name role' }, { path: 'verifiedBy', select: 'name role' }], strictPopulate: false })
      .populate({ path: 'created_by', select: 'name role', strictPopulate: false })
      .populate({ path: 'task_created_by', select: 'name role', strictPopulate: false })
      .populate({ path: 'verified_by', select: 'name role', strictPopulate: false })
      .populate({ path: 'verification_staff_id', select: 'name role', strictPopulate: false })
      .populate({ path: 'support_staff', select: 'name role', strictPopulate: false })
      .sort({ updatedAt: -1 }).limit(limit).lean(),
    (getModel('ShiprocketDeliveredOrder') || ShiprocketOrder).find(orderMatch)
      .populate({ path: 'lead_id', populate: { path: 'assignedTo', select: 'name role' }, strictPopulate: false })
      .populate({ path: 'verification_id', populate: [{ path: 'assignedTo', select: 'name role' }, { path: 'verifiedBy', select: 'name role' }], strictPopulate: false })
      .populate({ path: 'verification_staff_id', select: 'name role', strictPopulate: false })
      .populate({ path: 'created_by', select: 'name role', strictPopulate: false })
      .populate({ path: 'task_created_by', select: 'name role', strictPopulate: false })
      .populate({ path: 'support_staff', select: 'name role', strictPopulate: false })
      .sort({ updatedAt: -1 }).limit(limit).lean(),
    (getModel('ShiprocketInTransitOrder') || ShiprocketOrder).find(orderMatch)
      .populate({ path: 'lead_id', populate: { path: 'assignedTo', select: 'name role' }, strictPopulate: false })
      .populate({ path: 'verification_id', populate: [{ path: 'assignedTo', select: 'name role' }, { path: 'verifiedBy', select: 'name role' }], strictPopulate: false })
      .populate({ path: 'created_by', select: 'name role', strictPopulate: false })
      .populate({ path: 'verification_staff_id', select: 'name role', strictPopulate: false })
      .populate({ path: 'support_staff', select: 'name role', strictPopulate: false })
      .sort({ updatedAt: -1 }).limit(limit).lean(),
    (getModel('ShiprocketRtoOrder') || ShiprocketOrder).find(orderMatch)
      .populate({ path: 'lead_id', populate: { path: 'assignedTo', select: 'name role' }, strictPopulate: false })
      .populate({ path: 'verification_id', populate: [{ path: 'assignedTo', select: 'name role' }, { path: 'verifiedBy', select: 'name role' }], strictPopulate: false })
      .populate({ path: 'created_by', select: 'name role', strictPopulate: false })
      .populate({ path: 'support_staff', select: 'name role', strictPopulate: false })
      .sort({ updatedAt: -1 }).limit(limit).lean(),
    
    ShipmaxxOrder.find(orderMatch)
      .populate({ path: 'lead_id', populate: { path: 'assignedTo', select: 'name role' }, strictPopulate: false })
      .populate({ path: 'verification_id', populate: [{ path: 'assignedTo', select: 'name role' }, { path: 'verifiedBy', select: 'name role' }], strictPopulate: false })
      .populate({ path: 'verified_by', select: 'name role', strictPopulate: false })
      .populate({ path: 'created_by', select: 'name role', strictPopulate: false })
      .populate({ path: 'task_created_by', select: 'name role', strictPopulate: false })
      .populate({ path: 'support_staff', select: 'name role', strictPopulate: false })
      .sort({ updatedAt: -1 }).limit(limit).lean(),
    (getModel('ShipmaxxDeliveredOrder') || ShipmaxxOrder).find(orderMatch)
      .populate({ path: 'lead_id', populate: { path: 'assignedTo', select: 'name role' }, strictPopulate: false })
      .populate({ path: 'verification_id', populate: [{ path: 'assignedTo', select: 'name role' }, { path: 'verifiedBy', select: 'name role' }], strictPopulate: false })
      .populate({ path: 'verification_staff_id', select: 'name role', strictPopulate: false })
      .populate({ path: 'created_by', select: 'name role', strictPopulate: false })
      .populate({ path: 'support_staff', select: 'name role', strictPopulate: false })
      .sort({ updatedAt: -1 }).limit(limit).lean(),
    (getModel('ShipmaxxInTransitOrder') || ShipmaxxOrder).find(orderMatch)
      .populate({ path: 'lead_id', populate: { path: 'assignedTo', select: 'name role' }, strictPopulate: false })
      .populate({ path: 'verification_id', populate: [{ path: 'assignedTo', select: 'name role' }, { path: 'verifiedBy', select: 'name role' }], strictPopulate: false })
      .populate({ path: 'created_by', select: 'name role', strictPopulate: false })
      .populate({ path: 'support_staff', select: 'name role', strictPopulate: false })
      .sort({ updatedAt: -1 }).limit(limit).lean(),
    (getModel('ShipmaxxRtoOrder') || ShipmaxxOrder).find(orderMatch)
      .populate({ path: 'lead_id', populate: { path: 'assignedTo', select: 'name role' }, strictPopulate: false })
      .populate({ path: 'verification_id', populate: [{ path: 'assignedTo', select: 'name role' }, { path: 'verifiedBy', select: 'name role' }], strictPopulate: false })
      .populate({ path: 'created_by', select: 'name role', strictPopulate: false })
      .populate({ path: 'support_staff', select: 'name role', strictPopulate: false })
      .sort({ updatedAt: -1 }).limit(limit).lean(),
    
    InterestedLead.find(leadMatch).populate('assignedTo', 'name role').sort({ updatedAt: -1 }).limit(limit).lean(),
    NotInterestedLead.find(leadMatch).populate('assignedTo', 'name role').sort({ updatedAt: -1 }).limit(limit).lean(),
    PendingOrder.find(leadMatch).populate('assignedTo', 'name role').sort({ updatedAt: -1 }).limit(limit).lean(),
    OnHoldOrder.find(leadMatch).populate('assignedTo', 'name role').sort({ updatedAt: -1 }).limit(limit).lean(),
    VerifiedOrder.find(leadMatch).populate('assignedTo', 'name role').sort({ updatedAt: -1 }).limit(limit).lean(),
  ]);

  const allResults = [];
  
  const addResult = (record, type, module, phone, customerName, status, linkTemplate, assignedTo, note, extra = {}) => {
    if (!record || !record._id) return;
    
    const finalPhone = phone || (record.lead ? record.lead.phone : '') || record.billing_phone || '';
    const finalName = customerName || (record.lead ? record.lead.name : '') || record.billing_customer_name || 'Unknown';
    
    let problem = record.problem || (record.lead && record.lead.problem) || '';
    let department = record.department || (record.lead && record.lead.department) || '';
    
    let address = record.address || (record.lead && record.lead.address) || record.billing_address || '';
    let city = record.cityVillage || (record.lead && record.lead.cityVillage) || record.billing_city || '';
    let state = record.state || (record.lead && record.lead.state) || record.billing_state || '';
    let pincode = record.pincode || (record.lead && record.lead.pincode) || record.billing_pincode || '';
    
    let awb_code = record.awb_code || '';
    let courier_name = record.courier_name || '';
    let payment_method = record.payment_method || '';
    let sub_total = record.sub_total || '';

    let staffName = null;
    let staffRole = null;
    if (assignedTo) {
      if (typeof assignedTo === 'object') {
        staffName = assignedTo.name || null;
        staffRole = assignedTo.role || null;
      } else if (typeof assignedTo === 'string') {
        staffName = assignedTo;
        staffRole = extra.assignedRole || null;
      }
    }
    
    allResults.push({
      _id: record._id.toString(),
      type,
      module,
      phone: finalPhone,
      customerName: finalName,
      status: status || 'Unknown',
      createdAt: record.createdAt || new Date(),
      updatedAt: record.updatedAt || record.createdAt || new Date(),
      assignedTo: staffName,
      assignedRole: staffRole,
      note: note || '',
      link: linkTemplate.replace(':id', record._id.toString()),
      problem,
      department,
      address,
      city,
      state,
      pincode,
      awb_code,
      courier_name,
      payment_method,
      sub_total,
      kit_number: record.kit_number || 1,
      order_id: record.order_id || null,
      delivered_at: record.delivered_at || null,
      source_order_id: record.source_order_id || null,
      lead_id: record.lead_id?._id || record.lead_id || record.lead?._id || record.lead || null,
      leadAssignedStaff: record.lead_id?.assignedTo ? { name: record.lead_id.assignedTo.name, role: record.lead_id.assignedTo.role } : (record.lead?.assignedTo ? { name: record.lead.assignedTo.name, role: record.lead.assignedTo.role } : null),
      createdStaff: record.created_by ? { name: record.created_by.name, role: record.created_by.role } : (record.task_created_by ? { name: record.task_created_by.name, role: record.task_created_by.role } : null),
      supportStaff: record.support_staff ? { name: record.support_staff.name, role: record.support_staff.role } : null,
      verificationStaff: (record.verification_id?.assignedTo || record.verification_id?.verifiedBy || record.verifiedBy || record.verification_staff_id || record.verified_by) ? {
        name: (record.verification_id?.assignedTo?.name || record.verification_id?.verifiedBy?.name || record.verifiedBy?.name || record.verification_staff_id?.name || record.verified_by?.name),
        role: (record.verification_id?.assignedTo?.role || record.verification_id?.verifiedBy?.role || record.verifiedBy?.role || record.verification_staff_id?.role || record.verified_by?.role)
      } : null
    });
  };

  leads.forEach(l => {
    let module = 'Leads';
    let link = `/leads?openId=${l._id}`;
    if (['interested', 'closed_lost', 'on_hold'].includes(l.status)) {
      module = 'Action Required';
      link = `/pipeline?openId=${l._id}`;
    }
    const latestNote = l.notes && l.notes.length > 0 ? l.notes[l.notes.length - 1].text : (l.note || '');
    addResult(l, 'lead', module, l.phone, l.name, l.status, link, l.assignedTo, latestNote);
  });

  tasks.forEach(t => {
    const latestNote = t.notes && t.notes.length > 0 ? t.notes[t.notes.length - 1].text : (t.description || '');
    let moduleName = 'Tasks';
    let link = `/tasks?openId=${t._id}`;
    
    if (['ready_to_shipment', 'dispatch', 'dispatched'].includes(t.status)) {
      moduleName = 'Ready To Shipment';
      link = `/ready-to-shipment?openId=${t._id}`;
    } else if (t.status === 'verification') {
      moduleName = 'Verification';
      link = `/verification?openId=${t._id}`;
    } else if (['cancelled', 'cancel_call', 'cnp', 'on_hold', 'closed_lost', 'interested'].includes(t.status)) {
      moduleName = 'Action Required';
      link = `/pipeline?openId=${t.lead?._id || t._id}`;
    }

    addResult(t, 'task', moduleName, t.phone, t.lead?.name || t.title, t.status, link, t.assignedTo, latestNote);
  });

  verifications.forEach(v => {
    const latestNote = v.notes && v.notes.length > 0 ? v.notes[v.notes.length - 1].text : (v.description || '');
    addResult(v, 'verification', 'Verification', v.lead?.phone, v.lead?.name || v.title, v.status, `/verification?openId=${v._id}`, v.assignedTo, latestNote);
  });

  rtsRecords.forEach(r => {
    const latestNote = r.notes && r.notes.length > 0 ? r.notes[r.notes.length - 1].text : (r.description || '');
    addResult(r, 'rts', 'Ready to Shipment', r.lead?.phone, r.lead?.name || r.title, r.sentToShiprocket ? 'Sent to Shiprocket' : 'Pending', `/ready-to-shipment?openId=${r._id}`, r.assignedTo, latestNote);
  });

  callAgains.forEach(c => {
    const latestNote = c.notes && c.notes.length > 0 ? c.notes[c.notes.length - 1].text : '';
    addResult(c, 'callagain', 'Call Again', c.lead?.phone, c.lead?.name, 'CALL AGAIN', `/pipeline?openId=${c.lead?._id}&filter=call_again`, c.assignedTo, latestNote);
  });

  cnps.forEach(c => {
    const latestNote = c.notes && c.notes.length > 0 ? c.notes[c.notes.length - 1].text : '';
    addResult(c, 'cnp', 'CNP', c.lead?.phone, c.lead?.name, 'CNP', `/pipeline?openId=${c.lead?._id}&filter=cnp`, c.assignedTo, latestNote);
  });

  appointments.forEach(a => {
    const latestNote = a.notes || '';
    addResult(a, 'appointment', 'Appointments', a.phone, a.patientName, a.status, `/appointments?openId=${a._id}`, a.createdBy, latestNote);
  });

  interestedLeads.forEach(l => {
    const latestNote = l.notes && l.notes.length > 0 ? l.notes[l.notes.length - 1].text : (l.note || '');
    addResult(l, 'lead', 'Interested Leads', l.phone, l.name, 'Interested', `/pipeline?openId=${l._id}`, l.assignedTo, latestNote);
  });

  notInterestedLeads.forEach(l => {
    const latestNote = l.notes && l.notes.length > 0 ? l.notes[l.notes.length - 1].text : (l.rejectionReason || '');
    addResult(l, 'lead', 'Not Interested', l.phone, l.name, 'Not Interested', `/pipeline?openId=${l._id}`, l.assignedTo, latestNote);
  });

  pendingOrders.forEach(o => {
    const latestNote = o.notes && o.notes.length > 0 ? o.notes[o.notes.length - 1].text : (o.pendingReason || '');
    addResult(o, 'order', 'Pending Orders', o.phone, o.name, 'Pending', `/verification?openId=${o._id}`, o.assignedTo, latestNote);
  });

  onHoldOrders.forEach(o => {
    const latestNote = o.notes && o.notes.length > 0 ? o.notes[o.notes.length - 1].text : (o.onHoldReason || '');
    addResult(o, 'order', 'On Hold', o.phone, o.name, 'On Hold', `/pipeline?openId=${o._id}&filter=on_hold`, o.assignedTo, latestNote);
  });

  verifiedOrders.forEach(o => {
    const latestNote = o.notes && o.notes.length > 0 ? o.notes[o.notes.length - 1].text : (o.note || '');
    addResult(o, 'order', 'Verified Orders', o.phone, o.name, 'Verified', `/ready-to-shipment?openId=${o._id}`, o.assignedTo, latestNote);
  });

  const processedOrders = new Set();
  const processShiprocket = (ordersArr) => {
    ordersArr.forEach(o => {
      const uniqueKey = o.order_id || o.awb_code || o._id.toString();
      if (processedOrders.has(uniqueKey)) return;
      processedOrders.add(uniqueKey);
      const latestNote = o.notes || '';
      
      let moduleName = 'Shiprocket';
      let link = `/shiprocket/orders?openId=${o._id}`;
      
      if (o.status === 'DELIVERED') {
         moduleName = 'Follow Up';
         link = `/follow-up?openId=${o._id}`;
      }
      
      const staffUser = o.verification_id?.assignedTo || o.verification_staff_id || o.verified_by || o.created_by || o.task_created_by || o.lead_id?.assignedTo;
      addResult(o, 'order', moduleName, o.billing_phone, o.billing_customer_name, o.status, link, staffUser, latestNote);
    });
  };
  processShiprocket(shiprocketOrders);
  processShiprocket(shiprocketDelivered);
  processShiprocket(shiprocketInTransit);
  processShiprocket(shiprocketRto);

  const processedMaxxOrders = new Set();
  const processShipmaxx = (ordersArr) => {
    ordersArr.forEach(o => {
      const uniqueKey = o.order_id || o.awb_code || o._id.toString();
      if (processedMaxxOrders.has(uniqueKey)) return;
      processedMaxxOrders.add(uniqueKey);
      const latestNote = o.notes || '';
      
      let moduleName = 'ShipMaxx';
      let link = `/shipmaxx?openId=${o._id}`;
      
      if (o.status === 'DELIVERED') {
         moduleName = 'ShipMaxx Follow Up';
         link = `/shipmaxx/followup?openId=${o._id}`;
      }
      
      const staffUser = o.verification_id?.assignedTo || o.verification_id?.verifiedBy || o.verification_staff_id || o.verified_by || o.created_by || o.task_created_by || o.support_staff || o.lead_id?.assignedTo;
      addResult(o, 'shipmaxx', moduleName, o.billing_phone, o.billing_customer_name, o.status, link, staffUser, latestNote);
    });
  };
  processShipmaxx(shipmaxxOrders);
  processShipmaxx(shipmaxxDelivered);
  processShipmaxx(shipmaxxInTransit);
  processShipmaxx(shipmaxxRto);

  const grouped = {};
  allResults.forEach(r => {
    const rawPhone = r.phone ? r.phone.replace(/\D/g, '') : '';
    const key = rawPhone.length >= 7 ? rawPhone.slice(-10) : (r._id ? r._id.toString() : 'unknown');
    if (!key) return;
    if (!grouped[key]) {
      grouped[key] = { 
        phone: r.phone, 
        customerName: r.customerName,
        problem: '',
        department: '',
        address: '',
        city: '',
        state: '',
        pincode: '',
        records: [] 
      };
    }
    
    if (r.problem && !grouped[key].problem) grouped[key].problem = r.problem;
    if (r.department && !grouped[key].department) grouped[key].department = r.department;
    if (r.address && !grouped[key].address) grouped[key].address = r.address;
    if (r.city && !grouped[key].city) grouped[key].city = r.city;
    if (r.state && !grouped[key].state) grouped[key].state = r.state;
    if (r.pincode && !grouped[key].pincode) grouped[key].pincode = r.pincode;

    if (!grouped[key].records.find(rec => rec._id === r._id && rec.module === r.module)) {
       grouped[key].records.push(r);
    }
    if (r.customerName && r.customerName !== 'Unknown' && grouped[key].customerName === 'Unknown') {
      grouped[key].customerName = r.customerName;
    }
  });
  Object.values(grouped).forEach(group => {
    const orderRecords = group.records.filter(r => ['order', 'shipmaxx'].includes(r.type));
    orderRecords.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    orderRecords.forEach((order, index) => {
      order.kit_number = index + 1;
    });
  });

  const finalResults = Object.values(grouped).map(group => {
    group.records.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    const latestStatus = group.records[0];
    const history = group.records;

    const validProblems = history.filter(r => r.problem && r.problem.trim().length > 0);
    let bestProblem = '';
    const nonInterakt = validProblems.find(r => !r.problem.includes('[Interakt Message]') && !r.problem.includes('Clicked Ad:'));
    if (nonInterakt) {
        bestProblem = nonInterakt.problem;
    } else if (validProblems.length > 0) {
        bestProblem = validProblems[0].problem;
    }

    const recentDept = history.find(r => r.department);
    const recentLocation = history.find(r => r.address || r.city || r.state || r.pincode);

    latestStatus.problem = latestStatus.problem || bestProblem || group.problem;
    latestStatus.department = latestStatus.department || (recentDept ? recentDept.department : group.department);
    
    if (!latestStatus.address && !latestStatus.city) {
      if (recentLocation) {
        latestStatus.address = recentLocation.address || '';
        latestStatus.city = recentLocation.city || '';
        latestStatus.state = recentLocation.state || '';
        latestStatus.pincode = recentLocation.pincode || '';
      } else {
        latestStatus.address = group.address;
        latestStatus.city = group.city;
        latestStatus.state = group.state;
        latestStatus.pincode = group.pincode;
      }
    }

    const recentAssigned = history.find(r => r.assignedTo);
    latestStatus.assignedTo = latestStatus.assignedTo || (recentAssigned ? recentAssigned.assignedTo : null);

    return {
      customerName: group.customerName,
      phone: group.phone,
      latestStatus,
      history,
    };
  });

  let outputResults = finalResults;
  if (isPhoneQuery && cleanPhone) {
    const targetDigits = cleanPhone;
    const strictFiltered = finalResults.filter(group => {
      const gDigits = (group.phone || '').replace(/\D/g, '');
      return gDigits.includes(targetDigits) || targetDigits.includes(gDigits.slice(-10));
    });
    if (strictFiltered.length > 0) {
      outputResults = strictFiltered;
    }
  }

  const cleanQ = digitsOnly.length >= 10 ? digitsOnly.slice(-10) : digitsOnly;
  outputResults.sort((a, b) => {
    const aPhoneDigits = (a.phone || '').replace(/\D/g, '');
    const bPhoneDigits = (b.phone || '').replace(/\D/g, '');
    
    const aExact = (aPhoneDigits.endsWith(cleanQ) || aPhoneDigits === cleanQ) ? 2 : (aPhoneDigits.includes(cleanQ) ? 1 : 0);
    const bExact = (bPhoneDigits.endsWith(cleanQ) || bPhoneDigits === cleanQ) ? 2 : (bPhoneDigits.includes(cleanQ) ? 1 : 0);
    
    if (aExact !== bExact) return bExact - aExact;
    
    return new Date(b.latestStatus.updatedAt) - new Date(a.latestStatus.updatedAt);
  });

  // ── Commission chain: attach full order chain + submitter details to each result group ──
  // This satisfies requirement #8: global search shows the full order chain and all
  // submitter details together in one view, searchable by order ID, customer, or salesperson.
  try {
    const OrderChain     = (await import('../commission/orderChain.model.js')).default;
    const CommissionRecord = (await import('../commission/commissionRecord.model.js')).default;

    // Collect all lead IDs from the search result set
    const leadIdSet = new Set();
    for (const group of outputResults) {
      for (const rec of group.history || []) {
        // Extract lead _id from history records where available
        const r = rec;
        if (r.lead_id) leadIdSet.add(String(r.lead_id));
      }
    }

    // Also search leads directly by phone to catch all linked leads
    const matchingLeadsByPhone = await Lead.find(leadMatch).select('_id phone').lean();
    for (const l of matchingLeadsByPhone) leadIdSet.add(String(l._id));

    // Also search chains by submitter name (salesperson search)
    const matchingUsers = await (await import('../user/user.model.js')).default
      .find({ name: safeRegex }).select('_id').lean();
    const matchingUserIds = matchingUsers.map(u => u._id);
    if (matchingUserIds.length > 0) {
      const chainsByUser = await OrderChain.find({ submitter_id: { $in: matchingUserIds } })
        .select('lead_id').lean();
      for (const c of chainsByUser) leadIdSet.add(String(c.lead_id));
    }

    const allLeadIds = Array.from(leadIdSet).filter(Boolean);

    if (allLeadIds.length > 0) {
      // Fetch all chain entries for found leads in one query
      const mongoose = (await import('mongoose')).default;
      const chainEntries = await OrderChain.find({
        lead_id: { $in: allLeadIds.map(id => { try { return new mongoose.Types.ObjectId(id); } catch { return null; } }).filter(Boolean) },
      })
        .populate('submitter_id', 'name role')
        .populate('order_id', 'order_id billing_customer_name sub_total status delivered_at awb_code')
        .sort({ chain_seq: 1 })
        .lean();

      // Fetch all commission records for these chain entries
      const chainIds = chainEntries.map(e => e._id);
      const commRecords = await CommissionRecord.find({ chain_entry_id: { $in: chainIds } })
        .populate('staff_id', 'name role')
        .lean();

      // Build maps: leadId → chain entries; chainEntryId → commission records
      const chainMap   = {};
      const commMap    = {};
      for (const e of chainEntries) {
        const key = String(e.lead_id);
        if (!chainMap[key]) chainMap[key] = [];
        chainMap[key].push(e);
      }
      for (const c of commRecords) {
        const key = String(c.chain_entry_id);
        if (!commMap[key]) commMap[key] = [];
        commMap[key].push(c);
      }
      // Attach commissions to each chain entry
      for (const entries of Object.values(chainMap)) {
        for (const entry of entries) {
          entry.commissions = commMap[String(entry._id)] || [];
        }
      }

      // Attach order_chain to each result group by matching phone → lead IDs
      for (const group of outputResults) {
        // Find all lead IDs associated with this customer's phone number
        const groupPhone = (group.phone || '').replace(/\D/g, '');
        const groupLeadIds = matchingLeadsByPhone
          .filter(l => (l.phone || '').replace(/\D/g, '').includes(groupPhone) || groupPhone.includes((l.phone || '').replace(/\D/g, '')))
          .map(l => String(l._id));

        // Merge all chain entries for this customer's leads, sorted by chain_seq
        const groupChain = [];
        for (const lId of groupLeadIds) {
          if (chainMap[lId]) groupChain.push(...chainMap[lId]);
        }
        groupChain.sort((a, b) => a.chain_seq - b.chain_seq);

        group.order_chain = groupChain;
      }
    }
  } catch (chainErr) {
    // Commission chain enrichment must not block search results
    console.error('[Search] Commission chain enrichment failed:', chainErr.message);
  }

  // ── Compute Order Journey & Badges for each customer ──
  const computeOrderJourney = (group) => {
    const history = group.history || [];
    const orderChain = group.order_chain || [];

    // Real shipment / delivery orders (Shiprocket, Shipmaxx)
    const shipmentOrders = history
      .filter(r => ['shipmaxx'].includes(r.type) || (r.type === 'order' && !['Verified Orders', 'Pending Orders', 'On Hold'].includes(r.module)))
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    // Kit 1 shipment order (if placed / delivered)
    const firstShipment = shipmentOrders.length > 0 ? shipmentOrders[0] : null;

    // All verifications sorted ascending
    const verifications = history
      .filter(r => r.type === 'verification' || (r.type === 'order' && r.module === 'Verified Orders'))
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    // Find the original verification for Kit 1 (exclude re-verification / reorder titles)
    const originalVerif = verifications.find(v => {
      const title = ((v.title || '') + ' ' + (v.note || '')).toLowerCase();
      return !title.includes('re-verification') && !title.includes('reorder') && !title.includes('kit');
    }) || verifications[0];

    // All tasks sorted ascending
    const tasks = history
      .filter(r => r.type === 'task')
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    const originalTask = tasks.find(t => {
      const title = ((t.title || '') + ' ' + (t.note || '')).toLowerCase();
      return !title.includes('re-verification') && !title.includes('reorder') && !title.includes('kit');
    }) || tasks[0];

    // 1. Determine 1st Order Rep (Sales)
    let firstOrder = null;
    let firstStaffName = null;
    let firstStaffRole = 'sales';

    const chain1 = orderChain.find(c => c.chain_seq === 1 || c.order_type === 'first');
    if (chain1?.submitter_id?.name) {
      firstStaffName = chain1.submitter_id.name;
      firstStaffRole = chain1.submitter_id.role || 'sales';
    } else if (originalVerif?.assignedTo && originalVerif?.assignedRole === 'sales') {
      firstStaffName = originalVerif.assignedTo;
      firstStaffRole = 'sales';
    } else if (firstShipment?.verificationStaff?.role === 'sales') {
      firstStaffName = firstShipment.verificationStaff.name;
      firstStaffRole = 'sales';
    } else if (originalTask?.assignedTo && originalTask?.assignedRole === 'sales') {
      firstStaffName = originalTask.assignedTo;
      firstStaffRole = 'sales';
    } else if (firstShipment?.createdStaff?.role === 'sales') {
      firstStaffName = firstShipment.createdStaff.name;
      firstStaffRole = 'sales';
    } else if (originalVerif?.assignedTo && originalVerif?.assignedRole !== 'support') {
      firstStaffName = originalVerif.assignedTo;
      firstStaffRole = originalVerif.assignedRole || 'sales';
    } else if (originalTask?.assignedTo && originalTask?.assignedRole !== 'support') {
      firstStaffName = originalTask.assignedTo;
      firstStaffRole = originalTask.assignedRole || 'sales';
    } else if (firstShipment?.verificationStaff?.name) {
      firstStaffName = firstShipment.verificationStaff.name;
      firstStaffRole = firstShipment.verificationStaff.role || 'sales';
    } else if (firstShipment?.createdStaff?.name) {
      firstStaffName = firstShipment.createdStaff.name;
      firstStaffRole = firstShipment.createdStaff.role || 'sales';
    } else {
      const leadRec = history.find(r => r.type === 'lead');
      firstStaffName = originalVerif?.assignedTo || originalTask?.assignedTo || leadRec?.assignedTo || 'Sales Staff';
      firstStaffRole = originalVerif?.assignedRole || originalTask?.assignedRole || leadRec?.assignedRole || 'sales';
    }

    if (firstShipment) {
      firstOrder = {
        staffName: firstStaffName,
        staffRole: firstStaffRole,
        status: firstShipment.status || 'DELIVERED',
        orderId: firstShipment.order_id || null,
        awb: firstShipment.awb_code || null,
        subTotal: firstShipment.sub_total || null,
        date: firstShipment.delivered_at || firstShipment.createdAt,
        link: firstShipment.link,
        source: 'shipment_order'
      };
    } else if (originalVerif) {
      firstOrder = {
        staffName: firstStaffName,
        staffRole: firstStaffRole,
        status: originalVerif.status || 'Verified',
        date: originalVerif.createdAt,
        link: originalVerif.link,
        source: 'verification'
      };
    } else if (originalTask) {
      firstOrder = {
        staffName: firstStaffName,
        staffRole: firstStaffRole,
        status: originalTask.status || 'Active Task',
        date: originalTask.createdAt,
        link: originalTask.link,
        source: 'task'
      };
    } else {
      const leadRec = history.find(r => r.type === 'lead');
      if (leadRec && leadRec.assignedTo) {
        firstOrder = {
          staffName: leadRec.assignedTo,
          staffRole: leadRec.assignedRole || 'sales',
          status: leadRec.status || 'Active Lead',
          date: leadRec.createdAt,
          link: leadRec.link,
          isLeadOnly: true
        };
      }
    }

    // 2. Identify Reorder / Followup Order (Support rep)
    let repeatOrder = null;
    let hasReorder = false;

    // Check active or recent Re-Verification / Task / RTS created for reorder
    const reorderVerif = history.find(r => {
      const title = ((r.note || '') + ' ' + (r.title || '') + ' ' + (r.problem || '')).toLowerCase();
      const isReorderText = title.includes('re-verification') || title.includes('reorder') || title.includes('kit') || (r.assignedRole === 'support' && r.type !== 'lead');
      const isStage = ['verification', 'rts'].includes(r.type) || 
                      (r.type === 'task' && ['verification', 'ready_to_shipment', 'dispatch'].includes(r.status));
      return isReorderText && isStage;
    });

    const repeatChains = orderChain.filter(c => c.chain_seq > 1 || c.order_type === 'repeat')
      .sort((a, b) => b.chain_seq - a.chain_seq);

    const hasMultipleShipments = shipmentOrders.length > 1;
    const latestRepeatShipment = hasMultipleShipments ? shipmentOrders[shipmentOrders.length - 1] : null;

    if (reorderVerif) {
      hasReorder = true;
      repeatOrder = {
        staffName: reorderVerif.assignedTo || 'Support Staff',
        staffRole: reorderVerif.assignedRole || 'support',
        stage: reorderVerif.module || 'Ready to Shipment',
        status: reorderVerif.status || 'dispatch',
        date: reorderVerif.updatedAt || reorderVerif.createdAt,
        link: reorderVerif.link,
        isReorder: true,
        kitNumber: Math.max(shipmentOrders.length + 1, 2),
        note: reorderVerif.note || ''
      };
    } else if (repeatChains.length > 0) {
      hasReorder = true;
      const latestRepeat = repeatChains[0];
      repeatOrder = {
        staffName: latestRepeat.submitter_id?.name || 'Support Staff',
        staffRole: latestRepeat.submitter_id?.role || 'support',
        stage: 'Delivered Reorder',
        status: latestRepeat.order_id?.status || 'DELIVERED',
        orderId: latestRepeat.order_id?.order_id || null,
        awb: latestRepeat.order_id?.awb_code || null,
        subTotal: latestRepeat.order_id?.sub_total || null,
        date: latestRepeat.order_id?.delivered_at || latestRepeat.createdAt,
        isReorder: true,
        kitNumber: latestRepeat.chain_seq
      };
    } else if (latestRepeatShipment) {
      hasReorder = true;
      const supportStaff = latestRepeatShipment.supportStaff?.name || latestRepeatShipment.verificationStaff?.name || latestRepeatShipment.assignedTo || 'Support Staff';
      const supportRole = latestRepeatShipment.supportStaff?.role || latestRepeatShipment.verificationStaff?.role || latestRepeatShipment.assignedRole || 'support';
      repeatOrder = {
        staffName: supportStaff,
        staffRole: supportRole,
        stage: latestRepeatShipment.module || 'ShipMaxx Follow Up',
        status: latestRepeatShipment.status || 'DELIVERED',
        orderId: latestRepeatShipment.order_id || null,
        awb: latestRepeatShipment.awb_code || null,
        subTotal: latestRepeatShipment.sub_total || null,
        date: latestRepeatShipment.delivered_at || latestRepeatShipment.createdAt,
        link: latestRepeatShipment.link,
        isReorder: true,
        kitNumber: shipmentOrders.length
      };
    }

    // Build timeline milestones
    const steps = [];
    if (firstOrder) {
      steps.push({
        stepNumber: 1,
        label: firstOrder.isLeadOnly ? 'Lead (Sales)' : '1st Order (Sales)',
        staffName: firstOrder.staffName,
        staffRole: firstOrder.staffRole,
        status: firstOrder.status,
        date: firstOrder.date,
        orderId: firstOrder.orderId
      });
    }

    if (shipmentOrders.length > 1) {
      for (let i = 1; i < shipmentOrders.length; i++) {
        const ord = shipmentOrders[i];
        if (repeatOrder && repeatOrder.orderId && repeatOrder.orderId === ord.order_id) continue;
        steps.push({
          stepNumber: i + 1,
          label: `Kit ${ord.kit_number || (i + 1)} (Reorder)`,
          staffName: ord.verificationStaff?.name || ord.supportStaff?.name || ord.assignedTo || 'Support Staff',
          staffRole: ord.verificationStaff?.role || ord.supportStaff?.role || ord.assignedRole || 'support',
          status: ord.status,
          date: ord.delivered_at || ord.createdAt,
          orderId: ord.order_id
        });
      }
    }

    if (repeatOrder && (!repeatOrder.orderId || !steps.some(s => s.orderId === repeatOrder.orderId))) {
      steps.push({
        stepNumber: steps.length + 1,
        label: `Reorder #${repeatOrder.kitNumber || steps.length + 1} (Support)`,
        staffName: repeatOrder.staffName,
        staffRole: repeatOrder.staffRole,
        status: repeatOrder.status,
        stage: repeatOrder.stage,
        date: repeatOrder.date,
        orderId: repeatOrder.orderId
      });
    }

    return {
      hasReorder,
      firstOrder,
      repeatOrder,
      totalOrders: Math.max(shipmentOrders.length, orderChain.length, hasReorder ? 2 : (firstOrder && !firstOrder.isLeadOnly ? 1 : 0)),
      steps
    };
  };

  for (const group of outputResults) {
    try {
      group.orderJourney = computeOrderJourney(group);
    } catch (ojErr) {
      console.error('[Search] computeOrderJourney error:', ojErr.message);
    }
  }

  res.json(new ApiResponse(httpStatus.OK, outputResults.slice(0, 20), 'Search results'));
}));

export default router;

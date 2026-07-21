import express from 'express';
import mongoose from 'mongoose';
import auth from '../../middleware/auth.js';
import catchAsync from '../../utils/catchAsync.js';
import ApiResponse from '../../utils/ApiResponse.js';
import httpStatus from 'http-status';

import Lead from '../lead/lead.model.js';
import { Task } from '../task/task.model.js';
import Verification from '../verification/verification.model.js';
import ReadyToShipment from '../readytoshipment/readytoshipment.model.js';
import CallAgain from '../callagain/callagain.model.js';
import Cnp from '../cnp/cnp.model.js';
import Appointment from '../appointment/appointment.model.js';
import { Order as ShiprocketOrder } from '../shiprocket/models/order.model.js';
import { ShipmaxxOrder } from '../shipmaxx/models/shipmaxxOrder.model.js';

const getModel = (name) => {
  try { return mongoose.model(name); } catch(e) { return null; }
};

const router = express.Router();

router.get('/', auth('admin', 'manager', 'sales', 'support', 'logistics'), catchAsync(async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2) {
    return res.json(new ApiResponse(httpStatus.OK, [], 'Search results'));
  }

  const queryStr = q.trim();
  const regex = new RegExp(queryStr, 'i');
  let isValidObjectId = false;
  try {
    isValidObjectId = mongoose.Types.ObjectId.isValid(queryStr) && (String(new mongoose.Types.ObjectId(queryStr)) === queryStr);
  } catch (e) {}

  const limit = 20; 
  
  const leadMatch = { isDeleted: false, $or: [{ name: regex }, { phone: regex }, { email: regex }, { problem: regex }] };
  if (isValidObjectId) leadMatch.$or.push({ _id: queryStr });
  
  const orderMatch = { $or: [{ billing_customer_name: regex }, { billing_phone: regex }, { order_id: regex }, { awb_code: regex }] };

  try {
    const [leadPhones, orderPhones, maxxPhones, srDelivered, smDelivered] = await Promise.all([
      Lead.find(leadMatch).select('phone').limit(10).lean(),
      ShiprocketOrder.find(orderMatch).select('billing_phone').limit(10).lean(),
      ShipmaxxOrder.find(orderMatch).select('billing_phone').limit(10).lean(),
      (getModel('ShiprocketDeliveredOrder') || ShiprocketOrder).find(orderMatch).select('billing_phone').limit(10).lean(),
      (getModel('ShipmaxxDeliveredOrder') || ShipmaxxOrder).find(orderMatch).select('billing_phone').limit(10).lean(),
    ]);
    const phoneSet = new Set();
    const addPhone = (p) => { if (p) phoneSet.add(p.replace(/\D/g, '')); };
    leadPhones.forEach(l => addPhone(l.phone));
    orderPhones.forEach(o => addPhone(o.billing_phone));
    maxxPhones.forEach(o => addPhone(o.billing_phone));
    srDelivered.forEach(o => addPhone(o.billing_phone));
    smDelivered.forEach(o => addPhone(o.billing_phone));
    
    const expandedPhones = Array.from(phoneSet).filter(Boolean);
    if (expandedPhones.length > 0) {
      expandedPhones.forEach(p => {
        const reg = new RegExp(p, 'i');
        leadMatch.$or.push({ phone: reg });
        orderMatch.$or.push({ billing_phone: reg });
      });
    }
  } catch (err) {}
  
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
    shipmaxxRto
  ] = await Promise.all([
    Lead.find(leadMatch).populate('assignedTo', 'name').sort({ updatedAt: -1 }).limit(limit).lean(),
    Task.find({ isDeleted: false, $or: [{ title: regex }, { phone: regex }] }).populate('assignedTo', 'name').populate('lead', 'name phone problem department address cityVillage state pincode').sort({ updatedAt: -1 }).limit(limit).lean(),
    Verification.find({ isDeleted: false, $or: [{ title: regex }] }).populate('assignedTo', 'name').populate('lead', 'name phone problem department address cityVillage state pincode').sort({ updatedAt: -1 }).limit(limit).lean(),
    ReadyToShipment.find({ $or: [{ title: regex }] }).populate('lead', 'name phone problem department address cityVillage state pincode').populate('assignedTo', 'name').sort({ updatedAt: -1 }).limit(limit).lean(),
    Lead.find(leadMatch).select('_id').lean().then(matchedLeads => 
      CallAgain.find({ lead: { $in: matchedLeads.map(l => l._id) } }).populate('lead', 'name phone problem department address cityVillage state pincode').populate('assignedTo', 'name').sort({ updatedAt: -1 }).limit(limit).lean()
    ),
    Lead.find(leadMatch).select('_id').lean().then(matchedLeads => 
      Cnp.find({ lead: { $in: matchedLeads.map(l => l._id) } }).populate('lead', 'name phone problem department address cityVillage state pincode').populate('assignedTo', 'name').sort({ updatedAt: -1 }).limit(limit).lean()
    ),
    Appointment.find({ isDeleted: false, $or: [{ patientName: regex }, { phone: regex }] }).populate('createdBy', 'name').sort({ updatedAt: -1 }).limit(limit).lean(),
    
    ShiprocketOrder.find(orderMatch).populate({ path: 'lead_id', populate: { path: 'assignedTo', select: 'name' }, strictPopulate: false }).populate({ path: 'verification_id', populate: { path: 'assignedTo', select: 'name' }, strictPopulate: false }).sort({ updatedAt: -1 }).limit(limit).lean(),
    (getModel('ShiprocketDeliveredOrder') || ShiprocketOrder).find(orderMatch).populate({ path: 'lead_id', populate: { path: 'assignedTo', select: 'name' }, strictPopulate: false }).populate({ path: 'verification_staff_id', select: 'name', strictPopulate: false }).sort({ updatedAt: -1 }).limit(limit).lean(),
    (getModel('ShiprocketInTransitOrder') || ShiprocketOrder).find(orderMatch).populate({ path: 'lead_id', populate: { path: 'assignedTo', select: 'name' }, strictPopulate: false }).sort({ updatedAt: -1 }).limit(limit).lean(),
    (getModel('ShiprocketRtoOrder') || ShiprocketOrder).find(orderMatch).populate({ path: 'lead_id', populate: { path: 'assignedTo', select: 'name' }, strictPopulate: false }).sort({ updatedAt: -1 }).limit(limit).lean(),
    
    ShipmaxxOrder.find(orderMatch).populate({ path: 'lead_id', populate: { path: 'assignedTo', select: 'name' }, strictPopulate: false }).populate({ path: 'verified_by', select: 'name', strictPopulate: false }).sort({ updatedAt: -1 }).limit(limit).lean(),
    (getModel('ShipmaxxDeliveredOrder') || ShipmaxxOrder).find(orderMatch).populate({ path: 'lead_id', populate: { path: 'assignedTo', select: 'name' }, strictPopulate: false }).populate({ path: 'verification_staff_id', select: 'name', strictPopulate: false }).sort({ updatedAt: -1 }).limit(limit).lean(),
    (getModel('ShipmaxxInTransitOrder') || ShipmaxxOrder).find(orderMatch).populate({ path: 'lead_id', populate: { path: 'assignedTo', select: 'name' }, strictPopulate: false }).sort({ updatedAt: -1 }).limit(limit).lean(),
    (getModel('ShipmaxxRtoOrder') || ShipmaxxOrder).find(orderMatch).populate({ path: 'lead_id', populate: { path: 'assignedTo', select: 'name' }, strictPopulate: false }).sort({ updatedAt: -1 }).limit(limit).lean(),
  ]);

  const allResults = [];
  
  const addResult = (record, type, module, phone, customerName, status, linkTemplate, assignedTo, note) => {
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
    
    allResults.push({
      _id: record._id.toString(),
      type,
      module,
      phone: finalPhone,
      customerName: finalName,
      status: status || 'Unknown',
      createdAt: record.createdAt || new Date(),
      updatedAt: record.updatedAt || record.createdAt || new Date(),
      assignedTo: assignedTo || null,
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
      kit_number: record.kit_number || 1
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
    addResult(l, 'lead', module, l.phone, l.name, l.status, link, l.assignedTo?.name, latestNote);
  });

  tasks.forEach(t => {
    const latestNote = t.notes && t.notes.length > 0 ? t.notes[t.notes.length - 1].text : (t.description || '');
    let moduleName = 'Tasks';
    let link = `/tasks?openId=${t._id}`;
    
    if (t.status === 'ready_to_shipment') {
      moduleName = 'Ready To Shipment';
      link = `/ready-to-shipment?openId=${t._id}`;
    } else if (t.status === 'verification') {
      moduleName = 'Verification';
      link = `/verification?openId=${t._id}`;
    } else if (['cancelled', 'cancel_call', 'cnp', 'on_hold', 'closed_lost', 'interested'].includes(t.status)) {
      moduleName = 'Action Required';
      link = `/pipeline?openId=${t.lead?._id || t._id}`;
    }

    addResult(t, 'task', moduleName, t.phone, t.lead?.name || t.title, t.status, link, t.assignedTo?.name, latestNote);
  });

  verifications.forEach(v => {
    const latestNote = v.notes && v.notes.length > 0 ? v.notes[v.notes.length - 1].text : (v.description || '');
    addResult(v, 'verification', 'Verification', v.lead?.phone, v.lead?.name || v.title, v.status, `/verification?openId=${v._id}`, v.assignedTo?.name, latestNote);
  });

  rtsRecords.forEach(r => {
    const latestNote = r.notes && r.notes.length > 0 ? r.notes[r.notes.length - 1].text : (r.description || '');
    addResult(r, 'rts', 'Ready to Shipment', r.lead?.phone, r.lead?.name || r.title, r.sentToShiprocket ? 'Sent to Shiprocket' : 'Pending', `/ready-to-shipment?openId=${r._id}`, r.assignedTo?.name, latestNote);
  });

  callAgains.forEach(c => {
    const latestNote = c.notes && c.notes.length > 0 ? c.notes[c.notes.length - 1].text : '';
    addResult(c, 'callagain', 'Call Again', c.lead?.phone, c.lead?.name, 'CALL AGAIN', `/pipeline?openId=${c.lead?._id}&filter=call_again`, c.assignedTo?.name, latestNote);
  });

  cnps.forEach(c => {
    const latestNote = c.notes && c.notes.length > 0 ? c.notes[c.notes.length - 1].text : '';
    addResult(c, 'cnp', 'CNP', c.lead?.phone, c.lead?.name, 'CNP', `/pipeline?openId=${c.lead?._id}&filter=cnp`, c.assignedTo?.name, latestNote);
  });

  appointments.forEach(a => {
    const latestNote = a.notes || '';
    addResult(a, 'appointment', 'Appointments', a.phone, a.patientName, a.status, `/appointments?openId=${a._id}`, a.createdBy?.name, latestNote);
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
      
      addResult(o, 'order', moduleName, o.billing_phone, o.billing_customer_name, o.status, link, o.verification_id?.assignedTo?.name || o.verification_staff_id?.name || o.lead_id?.assignedTo?.name, latestNote);
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
      
      addResult(o, 'shipmaxx', moduleName, o.billing_phone, o.billing_customer_name, o.status, link, o.verification_staff_id?.name || o.verified_by?.name || o.lead_id?.assignedTo?.name, latestNote);
    });
  };
  processShipmaxx(shipmaxxOrders);
  processShipmaxx(shipmaxxDelivered);
  processShipmaxx(shipmaxxInTransit);
  processShipmaxx(shipmaxxRto);

  const grouped = {};
  allResults.forEach(r => {
    const key = r.phone ? r.phone.replace(/\D/g, '') : r._id;
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

  const cleanQ = queryStr.replace(/\D/g, '');
  finalResults.sort((a, b) => {
    const aExactPhone = a.phone && cleanQ && a.phone.includes(cleanQ) ? 1 : 0;
    const bExactPhone = b.phone && cleanQ && b.phone.includes(cleanQ) ? 1 : 0;
    if (aExactPhone !== bExactPhone) return bExactPhone - aExactPhone;
    
    return new Date(b.latestStatus.updatedAt) - new Date(a.latestStatus.updatedAt);
  });

  res.json(new ApiResponse(httpStatus.OK, finalResults.slice(0, 20), 'Search results'));
}));

export default router;

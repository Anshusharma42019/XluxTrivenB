import express from 'express';
import auth from '../../middleware/auth.js';
import catchAsync from '../../utils/catchAsync.js';
import ApiResponse from '../../utils/ApiResponse.js';
import Lead from '../lead/lead.model.js';
import { Order } from '../shiprocket/models/order.model.js';
import { Task } from '../task/task.model.js';
import Verification from '../verification/verification.model.js';
import ReadyToShipment from '../readytoshipment/readytoshipment.model.js';
import CallAgain from '../callagain/callagain.model.js';
import httpStatus from 'http-status';

const router = express.Router();

router.get('/', auth('admin', 'manager', 'sales', 'support', 'logistics'), catchAsync(async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 3) {
    return res.json(new ApiResponse(httpStatus.OK, [], 'Search results'));
  }

  const regex = new RegExp(q.trim(), 'i');

  const [leads, orders, tasks, rtsRecords, callAgains] = await Promise.all([
    Lead.find({ isDeleted: false, $or: [{ name: regex }, { phone: regex }, { email: regex }] })
      .populate('assignedTo', 'name')
      .sort({ createdAt: -1 }).limit(5).lean(),

    Order.find({ $or: [{ billing_customer_name: regex }, { billing_phone: regex }, { order_id: regex }, { awb_code: regex }] })
      .sort({ createdAt: -1 }).limit(5).lean(),

    Task.find({ isDeleted: false, $or: [{ title: regex }, { phone: regex }] })
      .populate('assignedTo', 'name').populate('lead', 'name phone')
      .sort({ createdAt: -1 }).limit(5).lean(),

    ReadyToShipment.find({ $or: [{ title: regex }] })
      .populate('lead', 'name phone').populate('assignedTo', 'name')
      .sort({ createdAt: -1 }).limit(5).lean(),

    Lead.find({ isDeleted: false, $or: [{ name: regex }, { phone: regex }] }).select('_id name phone').lean()
      .then(matchedLeads => CallAgain.find({ lead: { $in: matchedLeads.map(l => l._id) }, status: { $ne: 'done' } })
        .populate('lead', 'name phone').populate('assignedTo', 'name')
        .sort({ createdAt: -1 }).limit(5).lean()),
  ]);

  // Find which tasks have a verification record
  const taskIds = tasks.map(t => t._id);
  const verificationRecords = taskIds.length
    ? await Verification.find({ task: { $in: taskIds }, isDeleted: false }).select('task _id status').lean()
    : [];
  const verificationByTaskId = {};
  verificationRecords.forEach(v => { verificationByTaskId[v.task.toString()] = v; });

  // Also search RTS by lead phone
  const phoneMatchedLeads = await Lead.find({ isDeleted: false, phone: regex }).select('_id').lean();
  const phoneLeadIds = phoneMatchedLeads.map(l => l._id.toString());
  const extraRts = await ReadyToShipment.find({
    lead: { $in: phoneMatchedLeads.map(l => l._id) },
    _id: { $nin: rtsRecords.map(r => r._id) }
  }).populate('lead', 'name phone').populate('assignedTo', 'name').sort({ createdAt: -1 }).limit(5).lean();
  const allRts = [...rtsRecords, ...extraRts];

  const results = [
    ...leads.map(l => ({ type: 'lead', _id: l._id, title: l.name, subtitle: l.phone, meta: l.status, cnp: l.cnp || false, assignedTo: l.assignedTo?.name, createdAt: l.createdAt })),
    ...orders.map(o => ({ type: 'order', _id: o._id, title: o.billing_customer_name, subtitle: o.billing_phone, meta: o.status, orderId: o.order_id, awb: o.awb_code, createdAt: o.createdAt })),
    ...allRts.map(r => ({ type: 'rts', _id: r._id, title: r.title, subtitle: r.lead?.phone, meta: r.lead?.name, assignedTo: r.assignedTo?.name, price: r.price, createdAt: r.createdAt })),
    ...callAgains.map(c => ({ type: 'callagain', _id: c._id, title: c.lead?.name, subtitle: c.lead?.phone, meta: c.status, assignedTo: c.assignedTo?.name, createdAt: c.createdAt })),
    ...tasks.map(t => {
      const vRec = verificationByTaskId[t._id.toString()];
      if (vRec) {
        return { type: 'task', category: 'verification', _id: vRec._id, title: t.title, subtitle: t.phone || t.lead?.phone, meta: vRec.status, assignedTo: t.assignedTo?.name, createdAt: t.createdAt };
      }
      return { type: 'task', _id: t._id, title: t.title, subtitle: t.phone || t.lead?.phone, meta: t.status, assignedTo: t.assignedTo?.name, createdAt: t.createdAt };
    }),
  ];

  res.json(new ApiResponse(httpStatus.OK, results, 'Search results'));
}));

export default router;

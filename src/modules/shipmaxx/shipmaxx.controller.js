import catchAsync from '../../utils/catchAsync.js';
import ApiResponse from '../../utils/ApiResponse.js';
import smx from './shipmaxx.service.js';
import { ShipmaxxNdrNote as NdrNote } from './models/shipmaxxNdrNote.model.js';
import { ShipmaxxOrder as Order } from './models/shipmaxxOrder.model.js';
import { ShipmaxxFollowup as Followup } from './models/shipmaxxFollowup.model.js';
import { ShipmaxxDeliveredOrder as DeliveredOrder } from './models/shipmaxxDeliveredOrder.model.js';
import { ShipmaxxInTransitOrder as InTransitOrder } from './models/shipmaxxInTransitOrder.model.js';
import { ShipmaxxReadyToShipment as ReadyToShipment } from './models/shipmaxxReadyToShipment.model.js';
import { ShipmaxxRtoOrder as RTOOrder } from './models/shipmaxxRtoOrder.model.js';
import { ShipmaxxReturn as ShiprocketReturn } from './models/shipmaxxReturn.model.js';
import { Lead } from '../lead/lead.model.js';
import Task from '../task/task.model.js';
import Verification from '../verification/verification.model.js';
import { getNextOrderId } from '../shiprocket/counter/counter.model.js';

const DEFAULT_FOLLOWUP_TOTAL = 5;
const DEFAULT_FOLLOWUP_GAP_DAYS = 6;

// ── Shared ShipMaxx status normalization ─────────────────────────────────────
// ShipMaxx API returns short codes (DEL, INT, UND, etc.) — always normalize
// to full standard status names before storing in the database.
const SMX_STATUS_MAP = {
  DEL: 'DELIVERED',
  INT: 'IN_TRANSIT',
  UND: 'UNDELIVERED',
  RTO: 'RTO_DELIVERED',
  OFD: 'OUT_FOR_DELIVERY',
  DEX: 'UNDELIVERED_ATTEMPT_FAILURE',
  SC:  'SHIPPED',
  PCN: 'CANCELED',
  RRA: 'RTO_INITIATED',
  SPD: 'PICKUP_SCHEDULED',
  SPB: 'NEW',
  NFI: 'NEW',
  RTO_INT: 'RTO_IN_TRANSIT',
  RTO_OFD: 'RTO_OFD',
  RAD: 'REACHED_AT_DESTINATION_HUB',
  RBS: 'REACHED_BACK_AT_SELLER_CITY',
  MIS: 'MISROUTED',
  RTO_INTRANSIT: 'RTO_IN_TRANSIT',
  SHIPMENT_CANCELLED: 'CANCELED',
  DELIVERY_EXCEPTION: 'UNDELIVERED_ATTEMPT_FAILURE',
  SHIPMENT_BOOKED: 'NEW',
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

const setAutoFollowUps = async (orderId, deliveredAt) => {
  const total = DEFAULT_FOLLOWUP_TOTAL;
  const gap   = DEFAULT_FOLLOWUP_GAP_DAYS;
  const base  = new Date(deliveredAt);
  const ops = Array.from({ length: total }, (_, i) => {
    const scheduled_date = new Date(base);
    scheduled_date.setDate(scheduled_date.getDate() + (i * gap)); // 1st call on day 0, 2nd on day 6, etc.
    return {
      updateOne: {
        filter: { order_id: orderId, followup_number: i + 1 },
        update: { $setOnInsert: { order_id: orderId, followup_number: i + 1, scheduled_date, status: 'scheduled', completed: false } },
        upsert: true,
      },
    };
  });
  await Followup.bulkWrite(ops);
  await Order.findByIdAndUpdate(orderId, { auto_followups_set: true });
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
  const data = await smx.getOrder(req.params.order_id);
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
    const subTotal = (products || []).reduce((sum, p) => sum + (Number(p.price) * (Number(p.quantity) || 1)), 0) + (Number(other_charges) || 0) - (Number(total_discount) || 0);
    await Order.create({
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
      raw_response: smxRes,
    });
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
    const subTotal = (products || []).reduce((sum, p) => sum + (Number(p.price) * (Number(p.quantity) || 1)), 0) + (Number(other_charges) || 0) - (Number(total_discount) || 0);
    await Order.create({
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
      raw_response: smxRes,
    });
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
      await Order.findOneAndUpdate(
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
      await Order.findOneAndUpdate(
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
      await Order.findOneAndUpdate(
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
    await Order.findOneAndUpdate(
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

// ── NDR Notes (ShipMaxx) ──────────────────────────────────────────────────────
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
      { name:         { $regex: search, $options: 'i' } },
      { phone_number: { $regex: search, $options: 'i' } },
      { awb_number:   { $regex: search, $options: 'i' } },
    ];
  }
  const notes = await NdrNote.find(match).sort({ createdAt: -1 }).populate('createdBy', 'name role').lean();
  res.json(new ApiResponse(200, notes, 'ShipMaxx NDR notes fetched'));
});

export const getNdrList = catchAsync(async (req, res) => {
  const data = await smx.getNdrList(req.query);
  res.json(new ApiResponse(200, data, 'NDR list fetched'));
});

export const ndrAction = catchAsync(async (req, res) => {
  const { ndr_id } = req.params;
  const { action } = req.body;
  if (!ndr_id || !action) return res.json(new ApiResponse(400, null, 'ndr_id and action are required'));
  const data = await smx.ndrAction(ndr_id, req.body);
  res.json(new ApiResponse(200, data, 'NDR action performed'));
});

export const ndrBulkAction = catchAsync(async (req, res) => {
  const { ndr_ids, action } = req.body;
  if (!ndr_ids || !Array.isArray(ndr_ids) || !action) 
    return res.json(new ApiResponse(400, null, 'ndr_ids (array) and action are required'));
  const data = await smx.ndrBulkAction(req.body);
  res.json(new ApiResponse(200, data, 'NDR bulk action performed'));
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
    { new: true }
  ).lean();
  if (!note) return res.status(404).json(new ApiResponse(404, null, 'Note not found'));
  res.json(new ApiResponse(200, note, 'NDR note updated'));
});

export const deleteNdrNote = catchAsync(async (req, res) => {
  await NdrNote.findByIdAndDelete(req.params.id);
  res.json(new ApiResponse(200, null, 'NDR note deleted'));
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
      await Order.updateOne({ _id: o._id }, { $set: { delivered_at: actualDate, status_updated_at: actualDate } });
      results.push({ id, actualDate });
    } catch(e) {
      results.push({ id, error: e.message });
    }
  }
  res.json(new ApiResponse(200, results, 'Debug fix executed'));
});


export const getDeliveredStats = catchAsync(async (req, res) => {
  const { from, to } = req.query;
  const match = { platform: 'shipmaxx' };
  
  if (from && to) {
    const dateFilter = {
      $gte: new Date(from + 'T00:00:00.000+05:30'),
      $lte: new Date(to + 'T23:59:59.999+05:30'),
    };
    // Check delivered_at (for DELIVERED orders), status_updated_at (for all others),
    // and fall back to createdAt if neither is set
    match.$or = [
      { status: { $in: [/^delivered$/i, /^rto_delivered$/i, /^DEL$/i, /^RTO$/i] }, delivered_at: dateFilter },
      { status: { $in: [/^delivered$/i, /^rto_delivered$/i, /^DEL$/i, /^RTO$/i] }, delivered_at: { $exists: false }, status_updated_at: dateFilter },
      { status: { $in: [/^delivered$/i, /^rto_delivered$/i, /^DEL$/i, /^RTO$/i] }, delivered_at: null, status_updated_at: dateFilter },
      { status: { $not: /^(delivered|rto_delivered|DEL|RTO)$/i }, status_updated_at: dateFilter },
      { status_updated_at: { $exists: false }, createdAt: dateFilter },
      { status_updated_at: null, createdAt: dateFilter },
    ];
  }

  const [deliveredCountResult, statusBreakdown, revenueAggregation] = await Promise.all([
    Order.countDocuments({ status: /^delivered$/i, ...match }),
    Order.aggregate([
      { $match: match },
      { $group: { _id: '$status', count: { $sum: 1 }, revenue: { $sum: '$sub_total' } } },
      { $sort: { count: -1 } }
    ]),
    Order.aggregate([
      { $match: match },
      { $group: { _id: null, totalRevenue: { $sum: '$sub_total' } } }
    ])
  ]);

  // Post-process: merge any remaining short-code groups into their full-name equivalents
  const mergedMap = {};
  for (const item of statusBreakdown) {
    const normalizedId = normalizeShipmaxxStatus(item._id);
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

  res.json(new ApiResponse(200, { count: deliveredCountResult, revenue: totalRevenue, statusBreakdown: breakdown }, 'Delivered stats'));
});

export const getStatusOrders = catchAsync(async (req, res) => {
  const { status, from, to, limit = 50 } = req.query;
  if (!status) return res.status(400).json(new ApiResponse(400, null, 'Status is required'));

  const match = { platform: 'shipmaxx' };

  const reverseShortCodes = Object.entries(SMX_STATUS_MAP)
    .filter(([, fullName]) => fullName === status)
    .map(([shortCode]) => shortCode);
  const allVariants = [status, ...reverseShortCodes];

  match.status = { $in: allVariants.map(s => new RegExp(`^${s.replace(/[-_]/g, '[-_ ]')}$`, 'i')) };

  if (from && to) {
    const dateFilter = {
      $gte: new Date(from + 'T00:00:00.000+05:30'),
      $lte: new Date(to + 'T23:59:59.999+05:30'),
    };
    
    if (/^(delivered|rto_delivered|DEL|RTO)$/i.test(status)) {
      match.$or = [
        { delivered_at: dateFilter },
        { delivered_at: { $exists: false }, status_updated_at: dateFilter },
        { delivered_at: null, status_updated_at: dateFilter },
        { delivered_at: { $exists: false }, status_updated_at: { $exists: false }, createdAt: dateFilter },
        { delivered_at: null, status_updated_at: null, createdAt: dateFilter },
      ];
    } else {
      match.$or = [
        { status_updated_at: dateFilter },
        { status_updated_at: { $exists: false }, createdAt: dateFilter },
        { status_updated_at: null, createdAt: dateFilter },
      ];
    }
  }

  console.log('[DEBUG] getStatusOrders match query:', JSON.stringify(match, null, 2));

  const orders = await Order.find(match)
    .populate({ path: 'lead_id', select: 'phone email assignedTo', populate: { path: 'assignedTo', select: 'name role' } })
    .populate('comments.createdBy', 'name role')
    .sort({ status_updated_at: -1, delivered_at: -1, createdAt: -1 })
    .limit(Math.min(Number(limit) || 50, 500)).lean();

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
      const staff = o.lead_id?.assignedTo;
      if (staff) {
        o.staff_name = staff.name || '';
        o.staff_role = staff.role || '';
        return;
      }

      const cleanPhone = String(o.billing_phone || '').replace(/\D/g, '');
      const lead = (cleanPhone.length >= 10 && byPhone[cleanPhone]) || 
                   byName[(o.billing_customer_name || '').toLowerCase().trim()] || 
                   byPin[String(o.billing_pincode || '').trim()];

      if (lead) {
        o.staff_name = lead.assignedTo?.name || '';
        o.staff_role = lead.assignedTo?.role || '';
        if (!o.billing_phone || /^x+$/i.test(o.billing_phone)) o.billing_phone = lead.phone;
      } else {
        o.staff_name = '';
        o.staff_role = '';
      }
    });
  } else {
    orders.forEach(o => {
      o.staff_name = o.lead_id?.assignedTo?.name || '';
      o.staff_role = o.lead_id?.assignedTo?.role || '';
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

  const order = await Order.findOneAndUpdate(
    { _id: id, platform: 'shipmaxx' },
    { $push: { comments: comment } },
    { new: true }
  ).populate('comments.createdBy', 'name role').lean();

  if (!order) return res.status(404).json(new ApiResponse(404, null, 'Order not found'));
  res.json(new ApiResponse(200, order.comments || [], 'Order note saved'));
});

export const importOrders = catchAsync(async (req, res) => {
  // ShipMaxx does not provide a list-all-orders API endpoint.
  // Orders are created in CRM via createOrder and tracked via AWB.
  // This endpoint syncs tracking status for all existing CRM orders that have an AWB.
  const activeOrders = await Order.find({
    platform: 'shipmaxx',
    awb_code: { $exists: true, $ne: '' },
    status: { $not: /^(delivered|rto_delivered)/i }
  }).lean();

  let updatedCount = 0;
  for (const o of activeOrders) {
    try {
      const trackRes = await smx.trackShipment(o.awb_code);
      const tracking = trackRes?.data?.data || trackRes?.data || trackRes || {};
      const status = tracking.current_status || tracking.status || tracking.shipment_status || tracking.delivery_status;
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

        await Order.updateOne({ _id: o._id }, { $set: update });
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
        await Order.updateOne({ _id: existing._id }, { $set: fields });
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

export const syncShipmaxx = catchAsync(async (req, res) => {
  let updatedCount = 0;

  // 0. Fix existing orders with short-code statuses (one-time migration)
  for (const [shortCode, fullStatus] of Object.entries(SMX_STATUS_MAP)) {
    await Order.updateMany(
      { platform: 'shipmaxx', status: new RegExp(`^${shortCode}$`, 'i') },
      { $set: { status: fullStatus } }
    ).catch(() => {});
  }
  
  // 1. Sync ALL recent shipments from ShipMaxx to catch historical or externally created orders
  try {
    let page = 1;
    while (true) {
      const shipRes = await smx.getShipments({ limit: 50, per_page: 50, page });
      const shipments = shipRes?.data?.data || shipRes?.data || [];
      if (shipments.length === 0) break;

      for (const s of shipments) {
        if (!s.awb && !s.order_id) continue;
        
        const query = { platform: 'shipmaxx' };
        if (s.order_id) query.order_id = String(s.order_id);
        else query.awb_code = String(s.awb);

        const newStatus = normalizeShipmaxxStatus(s.status);
        const existing = await Order.findOne(query).select('status status_updated_at').lean();
        
        let statusUpdatedAt = s.date_added ? new Date(s.date_added) : new Date();
        if (existing) {
          if (existing.status === newStatus && existing.status_updated_at) {
             statusUpdatedAt = existing.status_updated_at;
          } else if (existing.status !== newStatus) {
             statusUpdatedAt = new Date(); // It changed just now!
          }
        }

        const updateData = {
          order_id: String(s.order_id || s.awb),
          awb_code: String(s.awb || ''),
          status: newStatus,
          platform: 'shipmaxx',
          payment_method: s.payment_method || '',
          status_updated_at: statusUpdatedAt,
        };
        const courier = s.carrier_name || s.courier_name || s.carrier;
        if (courier) updateData.courier_name = courier;

        if (s.created_at) updateData.createdAt = new Date(s.created_at);
        else if (s.date_added) updateData.createdAt = new Date(s.date_added);
        
        if (s.products && Array.isArray(s.products)) {
          updateData.order_items = s.products.map(p => ({
            name: p.name,
            sku: p.sku,
            units: p.quantity,
          }));
        }
        await Order.findOneAndUpdate(query, { $set: updateData }, { upsert: true }).catch(() => {});
        updatedCount++;
      }
      
      await new Promise(r => setTimeout(r, 1000));
      page++;
      if (page > 50) break; // safety limit
    }
  } catch (err) {
    console.error('[Sync ShipMaxx] Error fetching global shipments:', err.message);
  }

  // 1.5 Sync detailed order data (Revenue, Customer details)
  try {
    let orderPage = 1;
    while (true) {
      const ordersRes = await smx.fetchAllOrders({ limit: 50, per_page: 50, page: orderPage });
      const orders = ordersRes?.data?.data || ordersRes?.data || ordersRes?.orders || [];
      if (orders.length === 0) break;
      
      for (const o of orders) {
        if (!o.order_id) continue;
        
        const updateData = {
          platform: 'shipmaxx',
          billing_customer_name: o.customer_name || '',
          billing_phone: o.phone || '',
          billing_address: o.address || '',
          billing_pincode: o.billing_zip || o.shipping_zip || '',
          sub_total: Number(o.total_price) || 0,
        };
        const courier = o.carrier_name || o.courier_name || o.carrier;
        if (courier) updateData.courier_name = courier;

        if (o.created_at) updateData.createdAt = new Date(o.created_at);
        
        if (o.awb) updateData.awb_code = String(o.awb);
        
        await Order.findOneAndUpdate(
          { platform: 'shipmaxx', order_id: String(o.order_id) },
          { $set: updateData },
          { upsert: true }
        ).catch(() => {});
      }
      
      await new Promise(r => setTimeout(r, 1000));
      orderPage++;
      if (orderPage > 50) break; // safety limit
    }
  } catch (err) {
    console.error('[Sync ShipMaxx] Error fetching detailed orders:', err.message);
  }

  // 1.8 Update courier names for all Shipmaxx orders using accurate AWB mapping
  try {
    const allShipmaxxOrders = await Order.find({
      platform: 'shipmaxx',
      awb_code: { $exists: true, $ne: '' }
    }).select('order_id awb_code').lean();

    for (const o of allShipmaxxOrders) {
      try {
        const courier = guessCourierByAwb(o.awb_code);
        if (courier) {
          await Order.updateOne({ _id: o._id }, { $set: { courier_name: courier } });
        }
      } catch (e) {}
    }
  } catch (err) {
    console.error('[Sync ShipMaxx] Error in Step 1.8:', err.message);
  }

  // 1.9 Fetch missing address and amount details for older orders
  try {
    const missingDetails = await Order.find({
      platform: 'shipmaxx',
      order_id: { $exists: true, $ne: '' },
      $or: [
        { billing_address: { $exists: false } },
        { billing_address: { $in: [null, '', '-'] } },
        { billing_city: { $exists: false } },
        { billing_city: { $in: [null, '', '-'] } }
      ]
    }).select('order_id').lean().limit(100);

    for (const o of missingDetails) {
      try {
        const raw = await smx.getOrder(o.order_id);
        const smxOrder = raw?.data || raw || {};
        if (smxOrder.customer || smxOrder.billing_address || smxOrder.shipping_address) {
           const update = {
             billing_address: smxOrder.address || smxOrder.billing_address?.address || smxOrder.customer?.address || '',
             billing_city: smxOrder.city || smxOrder.billing_address?.city || smxOrder.customer?.city || '',
             billing_state: smxOrder.state || smxOrder.billing_address?.state || smxOrder.customer?.state || '',
             billing_pincode: smxOrder.billing_zip || smxOrder.shipping_zip || smxOrder.billing_address?.zip || smxOrder.customer?.zip || '',
             sub_total: Number(smxOrder.total_price || smxOrder.totals?.find(t => t.code === 'total')?.value) || 0
           };
           
           if (smxOrder.products && Array.isArray(smxOrder.products) && smxOrder.products.length > 0) {
              update.order_items = smxOrder.products.map(p => ({
                 name: p.name || 'Product', sku: p.sku || '', units: Number(p.quantity) || 1, selling_price: Number(p.price || p.selling_price) || 0
              }));
           }
           
           await Order.updateOne({ _id: o._id }, { $set: update });
        }
      } catch (e) {}
    }
  } catch (err) {
    console.error('[Sync ShipMaxx] Error fetching missing details:', err.message);
  }

  // 2. Sync recent NDR list from ShipMaxx to ensure we catch precise NDR failure reasons
  try {
    const ndrRes = await smx.getNdrList({ limit: 1000, per_page: 1000, page: 1 });
    const ndrs = ndrRes?.data?.shipments || ndrRes?.shipments || [];
    for (const ndr of ndrs) {
      if (!ndr.orderId && !ndr.awb) continue;
      
      let status = ndr.reason || 'UNDELIVERED';
      const attemptNumber = Number(ndr.attemptNumber) || 1;
      let mappedStatus = attemptNumber === 1 ? 'UNDELIVERED_1ST_ATTEMPT' :
                         attemptNumber === 2 ? 'UNDELIVERED_2ND_ATTEMPT' :
                         attemptNumber === 3 ? 'UNDELIVERED_3RD_ATTEMPT' : 'UNDELIVERED';
                         
      if (ndr.status && ndr.status.toLowerCase() === 'delivered') {
         mappedStatus = 'DELIVERED';
      } else if (ndr.status && ndr.status.toLowerCase().includes('rto delivered')) {
         mappedStatus = 'RTO_DELIVERED';
      }
      
      const query = { platform: 'shipmaxx' };
      if (ndr.orderId) query.order_id = String(ndr.orderId);
      else query.awb_code = String(ndr.awb);

      const updateData = {
        order_id: String(ndr.orderId || ndr.awb),
        awb_code: String(ndr.awb || ''),
        delivery_attempt: attemptNumber,
        status_updated_at: ndr.attemptDate ? parseShipMaxxDate(`${ndr.attemptDate} ${ndr.attemptTime || '00:00:00'}`) : new Date(),
        platform: 'shipmaxx',
      };
      
      // Only overwrite status if we have a valid mapping or if it's not already delivered in db
      const existingOrder = await Order.findOne(query);
      if (!existingOrder || (existingOrder.status !== 'DELIVERED' && existingOrder.status !== 'RTO_DELIVERED')) {
         updateData.status = mappedStatus;
      }
      
      if (ndr.customer) {
        if (ndr.customer.name) updateData.billing_customer_name = ndr.customer.name;
        if (ndr.customer.phone) updateData.billing_phone = ndr.customer.phone;
        if (ndr.customer.city) updateData.billing_city = ndr.customer.city;
        if (ndr.customer.state) updateData.billing_state = ndr.customer.state;
      }
      
      await Order.findOneAndUpdate(query, { $set: updateData }, { upsert: true }).catch(() => {});
    }
  } catch (err) {
    console.error('[Sync ShipMaxx] Error fetching NDRs:', err.message);
  }
  // 3. Track active orders to ensure live statuses are completely up to date
  const activeOrders = await Order.find({
    platform: 'shipmaxx',
    awb_code: { $exists: true, $ne: '' },
    status: { $not: /^(delivered|rto_delivered|cancelled|canceled)/i }
  }).lean();

  for (const o of activeOrders) {
    try {
      const trackRes = await smx.trackShipment(o.awb_code);
      const tracking = trackRes?.data?.data || trackRes?.data || trackRes || {};
      const rawStatus = tracking.current_status || tracking.status || tracking.shipment_status || tracking.delivery_status;
      if (rawStatus) {
        let status = normalizeShipmaxxStatus(rawStatus);

        // If it's a known NDR status from ShipMaxx, map it to the standard attempt status
        const ndrKeywords = ['EXCEPTION', 'REFUSED', 'NOT AVAILABLE', 'INCOMPLETE', 'ACTION TAKEN', 'ATTEMPT FAILURE', 'ADDRESS'];
        if (status === 'UNDELIVERED' || status === 'UNDELIVERED_ATTEMPT_FAILURE' || status === 'UNDELIVERED_FAILURE' || (ndrKeywords.some(k => status.includes(k)) && !status.includes('DELIVERED'))) {
           const attempt = o.delivery_attempt || 1;
           status = attempt === 1 ? 'UNDELIVERED_1ST_ATTEMPT' :
                    attempt === 2 ? 'UNDELIVERED_2ND_ATTEMPT' :
                    attempt === 3 ? 'UNDELIVERED_3RD_ATTEMPT' : 'UNDELIVERED';
        }
        
        const update = { status, status_updated_at: new Date() };
        
        if (!o.courier_name && o.awb_code) {
           const guessed = guessCourierByAwb(o.awb_code);
           if (guessed) update.courier_name = guessed;
        }

        if (tracking.history && Array.isArray(tracking.history) && tracking.history.length > 0) {
          const latestEvent = tracking.history[0];
          if (latestEvent && latestEvent.timestamp) {
            update.status_updated_at = parseShipMaxxDate(latestEvent.timestamp);
          }
        }
        
        if (status === 'DELIVERED') {
          let actualDeliveredAt = null;
          if (tracking.history && Array.isArray(tracking.history)) {
            const delEvent = tracking.history.find(h =>
              h.system_status_code === 'DEL' ||
              (h.system_status_name || '').toLowerCase() === 'delivered' ||
              (h.status || '').toLowerCase() === 'delivered'
            );
            if (delEvent && delEvent.timestamp) {
              actualDeliveredAt = parseShipMaxxDate(delEvent.timestamp);
            }
          }

          if (actualDeliveredAt) {
            update.delivered_at = actualDeliveredAt;
            update.status_updated_at = actualDeliveredAt;
          } else {
            const dbDoc = await Order.findOne({ _id: o._id }).select('delivered_at').lean();
            if (!dbDoc || !dbDoc.delivered_at) {
              update.delivered_at = new Date();
              update.status_updated_at = new Date();
            } else {
              update.status_updated_at = new Date(); // Keep old delivered_at
            }
          }
          // Update lead status to follow_up
          if (o.lead_id) await Lead.findByIdAndUpdate(o.lead_id, { status: 'follow_up' }).catch(() => {});
        }
        await Order.updateOne({ _id: o._id }, { $set: update });
        updatedCount++;
      }
    } catch (err) {
      console.error(`[Sync ShipMaxx] AWB ${o.awb_code} track error:`, err.message);
    }
  }

  // Auto set followups for newly delivered orders
  const needsFollowUps = await Order.find({
    platform: 'shipmaxx',
    status: /^delivered$/i,
    auto_followups_set: { $ne: true },
  }).select('_id delivered_at createdAt').lean();
  for (const o of needsFollowUps) {
    await setAutoFollowUps(o._id, o.delivered_at || o.createdAt || new Date());
  }

  // Sync delivered orders into DeliveredOrder collection
  const delivered = await Order.find({ platform: 'shipmaxx', status: /^delivered$/i })
    .select('order_id billing_customer_name billing_phone billing_email billing_address billing_city billing_state billing_pincode awb_code courier_name payment_method sub_total order_items status lead_id delivered_at createdAt').lean();
  for (const o of delivered) {
    await DeliveredOrder.findOneAndUpdate(
      { order_id: o.order_id },
      { $set: { order_id: o.order_id, billing_customer_name: o.billing_customer_name || '', billing_phone: o.billing_phone || '', billing_email: o.billing_email || '', billing_address: o.billing_address || '', billing_city: o.billing_city || '', billing_state: o.billing_state || '', billing_pincode: o.billing_pincode || '', awb_code: o.awb_code || '', courier_name: o.courier_name || '', payment_method: o.payment_method || '', sub_total: o.sub_total || 0, order_items: o.order_items || [], status: o.status, lead_id: o.lead_id || null, delivered_at: o.delivered_at || o.createdAt, order_date: o.createdAt } },
      { upsert: true }
    ).catch(() => {});
  }

  // Sync active orders into InTransitOrder collection
  const active = await Order.find({ platform: 'shipmaxx', status: { $not: /^(delivered|rto)/i } })
    .select('order_id billing_customer_name billing_phone billing_city billing_state billing_pincode awb_code courier_name payment_method sub_total order_items status lead_id status_updated_at createdAt').lean();
  for (const o of active) {
    await InTransitOrder.findOneAndUpdate(
      { order_id: o.order_id },
      { $set: { order_id: o.order_id, billing_customer_name: o.billing_customer_name || '', billing_phone: o.billing_phone || '', billing_city: o.billing_city || '', billing_state: o.billing_state || '', billing_pincode: o.billing_pincode || '', awb_code: o.awb_code || '', courier_name: o.courier_name || '', payment_method: o.payment_method || '', sub_total: o.sub_total || 0, order_items: o.order_items || [], status: o.status, lead_id: o.lead_id || null, status_updated_at: o.status_updated_at || o.createdAt, order_date: o.createdAt } },
      { upsert: true }
    ).catch(() => {});
  }
  await InTransitOrder.deleteMany({ order_id: { $in: delivered.map(o => o.order_id) } }).catch(() => {});

  res.json(new ApiResponse(200, { updatedCount, deliveredSynced: delivered.length, activeSynced: active.length }, `Sync complete. Updated: ${updatedCount} orders.`));
});

export const getOrders = catchAsync(async (req, res) => {
  const { status, from, to, search, page = 1, limit = 50, has_awb } = req.query;
  const match = { platform: 'shipmaxx' };

  if (has_awb === 'true') {
    match.awb_code = { $exists: true, $ne: '' };
  }

  if (status && status !== 'all') {
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
      .populate('comments.createdBy', 'name role')
      .sort({ createdAt: -1 })
      .skip((pg - 1) * lim)
      .limit(lim)
      .lean(),
    Order.countDocuments(match)
  ]);

  orders.forEach(o => {
    o.staff_name = o.lead_id?.assignedTo?.name || '';
    o.staff_role = o.lead_id?.assignedTo?.role || '';
  });

  res.json(new ApiResponse(200, { data: orders, total }, 'Orders fetched successfully'));
});


// ── Delivered Orders ──────────────────────────────────────────────────────────
export const getDeliveredOrders = catchAsync(async (req, res) => {
  const { search, page = 1, per_page = 50, from, to } = req.query;
  const match = { platform: 'shipmaxx', status: /^delivered$/i };
  if (from || to) {
    match.delivered_at = {};
    if (from) match.delivered_at.$gte = new Date(from + 'T00:00:00.000+05:30');
    if (to)   match.delivered_at.$lte = new Date(to + 'T23:59:59.999+05:30');
  }
  if (search) {
    const q = String(search).trim();
    match.$or = [
      { billing_customer_name: { $regex: q, $options: 'i' } },
      { billing_phone: { $regex: q, $options: 'i' } },
      { order_id: { $regex: q, $options: 'i' } },
      { awb_code: { $regex: q, $options: 'i' } },
    ];
  }
  const skip = (Number(page) - 1) * Number(per_page);
  const [orders, total] = await Promise.all([
    Order.find(match)
      .populate({ path: 'lead_id', select: 'phone email assignedTo', populate: { path: 'assignedTo', select: 'name role' } })
      .sort({ delivered_at: -1, createdAt: -1 })
      .skip(skip).limit(Number(per_page)).lean(),
    Order.countDocuments(match),
  ]);
  orders.forEach(o => {
    o.staff_name = o.lead_id?.assignedTo?.name || '';
    o.staff_role = o.lead_id?.assignedTo?.role || '';
  });
  res.json(new ApiResponse(200, { data: orders, total }, 'Delivered orders fetched'));
});

export const getDeliveredOrdersFromSchema = catchAsync(async (req, res) => {
  const { page = 1, per_page = 50, search, from, to } = req.query;

  // Auto-sync delivered orders from Order collection
  const newDelivered = await Order.find({ platform: 'shipmaxx', status: /^delivered$/i })
    .select('order_id billing_customer_name billing_phone billing_email billing_address billing_city billing_state billing_pincode awb_code courier_name payment_method sub_total order_items status lead_id delivered_at createdAt').lean();
  for (const o of newDelivered) {
    await DeliveredOrder.findOneAndUpdate(
      { order_id: o.order_id },
      { $set: { order_id: o.order_id, billing_customer_name: o.billing_customer_name || '', billing_phone: o.billing_phone || '', billing_email: o.billing_email || '', billing_address: o.billing_address || '', billing_city: o.billing_city || '', billing_state: o.billing_state || '', billing_pincode: o.billing_pincode || '', awb_code: o.awb_code || '', courier_name: o.courier_name || '', payment_method: o.payment_method || '', sub_total: o.sub_total || 0, order_items: o.order_items || [], status: o.status, lead_id: o.lead_id || null, delivered_at: o.delivered_at || o.createdAt, order_date: o.createdAt } },
      { upsert: true }
    ).catch(() => {});
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
    if (to)   matchQ.delivered_at.$lte = new Date(to + 'T23:59:59.999+05:30');
  }
  const [data, total] = await Promise.all([
    DeliveredOrder.find(matchQ).sort({ delivered_at: -1 }).skip(skip).limit(Number(per_page)).lean(),
    DeliveredOrder.countDocuments(matchQ),
  ]);
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
    ).catch(() => {});
  }
  await InTransitOrder.deleteMany({ status: { $regex: /^(delivered|rto)/i } }).catch(() => {});

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
    if (to)   matchQ.order_date.$lte = new Date(to + 'T23:59:59.999+05:30');
  }
  const [data, total] = await Promise.all([
    InTransitOrder.find(matchQ).sort({ status_updated_at: -1 }).skip(skip).limit(Number(per_page)).lean(),
    InTransitOrder.countDocuments(matchQ),
  ]);
  res.json(new ApiResponse(200, { data, total }, 'In-transit orders fetched'));
});

async function getKitNumbersMap(ordersArray, OrderModel) {
  if (!ordersArray || ordersArray.length === 0) return {};
  
  const allPhones = ordersArray
    .map(o => String(o.billing_phone || '').replace(/\D/g, ''))
    .filter(p => p.length >= 10);
  const uniquePhones = [...new Set(allPhones)];
  
  if (uniquePhones.length === 0) return {};

  // Find all delivered orders that match any of these phones
  const regexConditions = uniquePhones.map(p => ({ billing_phone: { $regex: p } }));
  const historicalOrders = await OrderModel.find({
    platform: 'shipmaxx',
    status: /^delivered$/i,
    $or: regexConditions
  }).select('_id billing_phone delivered_at createdAt').lean();

  const phoneHistory = {};
  for (const ho of historicalOrders) {
    const p = String(ho.billing_phone || '').replace(/\D/g, '');
    const matchedPhone = uniquePhones.find(up => p.includes(up) || up.includes(p));
    const key = matchedPhone || p;
    if (!phoneHistory[key]) phoneHistory[key] = [];
    phoneHistory[key].push(ho);
  }

  const orderKitMap = {};
  for (const p in phoneHistory) {
    const list = phoneHistory[p];
    list.sort((a, b) => new Date(a.delivered_at || a.createdAt) - new Date(b.delivered_at || b.createdAt));
    list.forEach((ho, index) => {
      orderKitMap[String(ho._id)] = index + 1;
    });
  }
  return orderKitMap;
}

// ── Follow-ups ────────────────────────────────────────────────────────────────
export const getOrdersWithFollowUps = catchAsync(async (req, res) => {
  const query = {
    platform: 'shipmaxx',
    status: /^delivered$/i,
    followup_done: { $ne: true },
    sent_to_verification: { $ne: true },
  };

  const delivered = await Order.find(query)
    .populate({ path: 'lead_id', select: 'assignedTo createdBy status problem note', populate: [{ path: 'assignedTo', select: 'name role' }, { path: 'createdBy', select: 'name role' }] })
    .populate('created_by', 'name role')
    .sort({ delivered_at: -1, createdAt: -1 }).lean();

  // Auto-set followups for orders that don't have them yet
  const needsSetting = delivered.filter(o => !o.auto_followups_set);
  if (needsSetting.length) {
    await Promise.all(needsSetting.map(o => setAutoFollowUps(o._id, o.delivered_at || o.createdAt || new Date())));
  }

  const allFollowups = await Followup.find({ order_id: { $in: delivered.map(o => o._id) } })
    .sort({ followup_number: 1 }).lean();

  const fuMap = {};
  for (const fu of allFollowups) {
    const key = String(fu.order_id);
    if (!fuMap[key]) fuMap[key] = [];
    fuMap[key].push(fu);
  }

  // Find leads for unlinked orders by phone to get their verification problems
  const unlinkedPhones = delivered
    .filter(o => !o.lead_id)
    .map(o => String(o.billing_phone || '').replace(/\D/g, ''))
    .filter(p => p.length >= 10);
  
  const unlinkedLeads = unlinkedPhones.length > 0 
    ? await Lead.find({ phone: { $in: unlinkedPhones } }).select('_id phone problem').lean()
    : [];
  
  const unlinkedLeadMap = {};
  for (const l of unlinkedLeads) unlinkedLeadMap[l.phone] = l;

  // Fetch Verification records for all leads (linked and unlinked)
  const linkedLeadIds = delivered.map(o => o.lead_id?._id).filter(Boolean);
  const allLeadIds = [...linkedLeadIds, ...unlinkedLeads.map(l => l._id)];
  
  const verifications = await Verification.find({ lead: { $in: allLeadIds } }).sort({ createdAt: -1 }).lean();
  const verifMap = {};
  for (const v of verifications) {
    const lId = String(v.lead);
    if (!verifMap[lId]) verifMap[lId] = v; // keep the latest one
  }

  const kitMap = await getKitNumbersMap(delivered, Order);

  const enriched = delivered.map(o => {
    let lId = o.lead_id?._id;
    if (!lId) {
      const cleanPhone = String(o.billing_phone || '').replace(/\D/g, '');
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
  res.json(new ApiResponse(200, enriched, 'Orders with follow-ups fetched'));
});

export const completeFollowUp = catchAsync(async (req, res) => {
  const { id } = req.params;
  const total = DEFAULT_FOLLOWUP_TOTAL;
  const gap   = DEFAULT_FOLLOWUP_GAP_DAYS;

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
  res.json(new ApiResponse(200, { completedCount: current.followup_number, next_follow_up: nextDate, total_followups: total, followup_gap_days: gap }, 'Follow-up completed'));
});

export const getCompletedFollowUps = catchAsync(async (req, res) => {
  const { search, page = 1, per_page = 20 } = req.query;
  const match = { platform: 'shipmaxx', status: /^delivered$/i, followup_done: true };
  if (search) match.$or = [
    { billing_customer_name: { $regex: search, $options: 'i' } },
    { billing_phone: { $regex: search, $options: 'i' } },
    { order_id: { $regex: search, $options: 'i' } },
    { awb_code: { $regex: search, $options: 'i' } },
  ];

  const skip = (Number(page) - 1) * Number(per_page);
  const [orders, total] = await Promise.all([
    Order.find(match)
      .populate({ path: 'lead_id', select: 'assignedTo createdBy status problem note', populate: [{ path: 'assignedTo', select: 'name role' }, { path: 'createdBy', select: 'name role' }] })
      .sort({ delivered_at: -1 }).skip(skip).limit(Number(per_page)).lean(),
    Order.countDocuments(match),
  ]);

  const allFollowups = await Followup.find({ order_id: { $in: orders.map(o => o._id) } })
    .sort({ followup_number: 1 }).lean();
  const fuMap = {};
  for (const fu of allFollowups) {
    const key = String(fu.order_id);
    if (!fuMap[key]) fuMap[key] = [];
    fuMap[key].push(fu);
  }

  // Find leads for unlinked orders by phone
  const unlinkedPhones = orders
    .filter(o => !o.lead_id)
    .map(o => String(o.billing_phone || '').replace(/\D/g, ''))
    .filter(p => p.length >= 10);
  
  const unlinkedLeads = unlinkedPhones.length > 0 
    ? await Lead.find({ phone: { $in: unlinkedPhones } }).select('_id phone problem').lean()
    : [];
  
  const unlinkedLeadMap = {};
  for (const l of unlinkedLeads) unlinkedLeadMap[l.phone] = l;

  const linkedLeadIds = orders.map(o => o.lead_id?._id).filter(Boolean);
  const allLeadIds = [...linkedLeadIds, ...unlinkedLeads.map(l => l._id)];
  
  const verifications = await Verification.find({ lead: { $in: allLeadIds } }).sort({ createdAt: -1 }).lean();
  const verifMap = {};
  for (const v of verifications) {
    const lId = String(v.lead);
    if (!verifMap[lId]) verifMap[lId] = v; // keep the latest one
  }

  const kitMap = await getKitNumbersMap(orders, Order);

  const enriched = orders.map(o => {
    let lId = o.lead_id?._id;
    if (!lId) {
      const cleanPhone = String(o.billing_phone || '').replace(/\D/g, '');
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
  const order = await Order.findByIdAndUpdate(id, { ...(next_follow_up ? { next_follow_up: new Date(next_follow_up) } : {}) }, { new: true }).select('next_follow_up').lean();
  res.json(new ApiResponse(200, order, 'Follow up added'));
});

export const setNextFollowUp = catchAsync(async (req, res) => {
  const order = await Order.findByIdAndUpdate(req.params.id, { next_follow_up: req.body.next_follow_up ? new Date(req.body.next_follow_up) : null }, { new: true }).select('next_follow_up').lean();
  res.json(new ApiResponse(200, order, 'Next follow up set'));
});

export const updateFollowupRelief = catchAsync(async (req, res) => {
  const { followup_number, relief_percentage } = req.body;
  if (!followup_number || relief_percentage === undefined)
    return res.status(400).json(new ApiResponse(400, null, 'followup_number and relief_percentage required'));
  const fu = await Followup.findOneAndUpdate(
    { order_id: req.params.id, followup_number: Number(followup_number) },
    { $set: { relief_percentage: Number(relief_percentage) } },
    { new: true }
  );
  if (!fu) return res.status(404).json(new ApiResponse(404, null, 'Followup not found'));
  res.json(new ApiResponse(200, fu, 'Relief percentage updated'));
});

// ── Order Activity & Contact ──────────────────────────────────────────────────
export const getOrderActivity = catchAsync(async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, platform: 'shipmaxx' })
    .select('comments notes order_id billing_customer_name status createdAt')
    .populate('comments.createdBy', 'name role').lean();
  if (!order) return res.status(404).json(new ApiResponse(404, null, 'Order not found'));
  const activity = (order.comments || []).map(c => ({
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
  const order = await Order.findOneAndUpdate({ _id: id, platform: 'shipmaxx' }, { $set: update }, { new: true })
    .select(allowed.join(' ') + ' lead_id').lean();
  if (!order) return res.status(404).json(new ApiResponse(404, null, 'Order not found'));
  if (order.lead_id) {
    const leadUpdate = {};
    if (update.billing_phone)   leadUpdate.phone       = update.billing_phone;
    if (update.billing_city)    leadUpdate.cityVillage = update.billing_city;
    if (update.billing_state)   leadUpdate.state       = update.billing_state;
    if (update.billing_pincode) leadUpdate.pincode     = update.billing_pincode;
    if (update.billing_address) leadUpdate.address     = update.billing_address;
    if (Object.keys(leadUpdate).length) await Lead.findByIdAndUpdate(order.lead_id, { $set: leadUpdate });
  }
  res.json(new ApiResponse(200, order, 'Contact updated'));
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

  let lead = await Lead.findOne({ phone: { $regex: last10 }, isDeleted: { $ne: true } }).lean();

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
  const order = await Order.findOne({ _id: id, platform: 'shipmaxx' }).populate('lead_id');
  if (!order) return res.status(404).json(new ApiResponse(404, null, 'Order not found'));

  let lead = order.lead_id;
  if (!lead) {
    const phone = order.billing_phone;
    if (phone && String(phone).replace(/\D/g, '').length >= 10) {
      lead = await Lead.findOne({ phone, isDeleted: { $ne: true } });
    }
    if (!lead) {
      lead = await Lead.create({
        name: order.billing_customer_name || 'Unknown Customer',
        phone: order.billing_phone || 'N/A',
        address: order.billing_address || '',
        status: 'follow_up',
        createdBy: req.user._id,
      });
      await Order.findByIdAndUpdate(id, { lead_id: lead._id });
    }
  }

  const followups = await Followup.find({ order_id: id }).sort({ followup_number: 1 }).lean();
  const lastRelief = [...followups].reverse().find(f => f.relief_percentage != null)?.relief_percentage ?? null;

  const task = await Task.create({
    title: `Re-Verification for ${lead.name || order.billing_customer_name}`,
    lead: lead._id,
    assignedTo: lead.assignedTo || req.user._id,
    createdBy: req.user._id,
    status: 'verification',
    dueDate: new Date(),
    cityVillage: order.billing_city,
    state: order.billing_state,
    pincode: order.billing_pincode,
    address: order.billing_address,
    phone: order.billing_phone,
    price: order.sub_total,
  });

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
    price: task.price,
    relief_percentage: lastRelief,
  });

  await Order.findByIdAndUpdate(id, { followup_done: true, sent_to_verification: true, verified_by: task.assignedTo });
  await Lead.findByIdAndUpdate(lead._id, { $set: { pending_reorder_source: id, pending_reorder_staff: task.assignedTo } });

  res.json(new ApiResponse(200, task, 'Order sent to verification successfully'));
});

// ── Manual Followup ───────────────────────────────────────────────────────────
export const createManualFollowup = catchAsync(async (req, res) => {
  const { name, phone, city, state, medicine, delivered_date, amount, order_id, courier_name, payment_method, pincode, address } = req.body;
  if (!name || !phone || !medicine || !delivered_date)
    return res.status(400).json(new ApiResponse(400, null, 'name, phone, medicine, delivered_date are required'));

  const mockOrderId = order_id ? `${order_id}-M${Date.now()}` : `SMX-MANUAL-${Date.now()}`;
  const d = new Date(delivered_date);

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
    auto_followups_set: true,
  });

  const total = DEFAULT_FOLLOWUP_TOTAL;
  const gap   = DEFAULT_FOLLOWUP_GAP_DAYS;
  const followups = [];
  let baseDate = new Date();
  for (let i = 1; i <= total; i++) {
    if (i > 1) baseDate.setDate(baseDate.getDate() + gap);
    followups.push({ order_id: newOrder._id, followup_number: i, scheduled_date: new Date(baseDate), status: 'scheduled', note: '' });
  }
  await Followup.insertMany(followups);

  res.json(new ApiResponse(200, newOrder, 'Manual followup added successfully'));
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

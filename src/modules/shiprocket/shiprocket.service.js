import axios from 'axios';

const BASE_URL = process.env.SHIPROCKET_BASE_URL || 'https://apiv2.shiprocket.in/v1/external';

// ── Token cache ───────────────────────────────────────────────────────────────
let _token = null;
let _tokenExpiry = 0;
const TOKEN_TTL_MS = 23 * 60 * 60 * 1000;

const getToken = async () => {
  if (_token && Date.now() < _tokenExpiry) return _token;
  const { data } = await axios.post(`${BASE_URL}/auth/login`, {
    email: process.env.SHIPROCKET_EMAIL,
    password: process.env.SHIPROCKET_PASSWORD,
  });
  if (!data.token) throw new Error(data.message || 'Shiprocket login failed');
  _token = data.token;
  _tokenExpiry = Date.now() + TOKEN_TTL_MS;
  return _token;
};

// ── Raw axios call with auto-retry on 401 ─────────────────────────────────────
const call = async (method, url, options = {}) => {
  const token = await getToken();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // ── Debug: log every outgoing request ──
  console.log(`[Shiprocket Request] ${method} ${url}`);
  if (options.data) console.log('[Shiprocket Payload]:', JSON.stringify(options.data, null, 2));

  try {
    const res = await axios({ method, url: `${BASE_URL}${url}`, headers, ...options });
    // Shiprocket sometimes returns 200 with error info in the body
    if (res.data?.status_code === 500 || res.data?.data?.status_code === 500) {
      const msg = res.data?.message || res.data?.data?.message || 'Shiprocket internal error';
      console.error(`[Shiprocket Error] 500 in body for ${url}:`, msg);
      throw new Error(msg);
    }
    return res.data;
  } catch (err) {
    if (err.response?.status === 401) {
      console.warn(`[Shiprocket Auth] Token expired (401) for ${url}. Refreshing...`);
      _token = null;
      try {
        const freshToken = await getToken();
        console.log('[Shiprocket Auth] Token refreshed successfully.');
        const res = await axios({
          method, url: `${BASE_URL}${url}`,
          headers: { Authorization: `Bearer ${freshToken}`, 'Content-Type': 'application/json' },
          ...options,
        });
        return res.data;
      } catch (retryErr) {
        console.error(`[Shiprocket Auth] Retry failed for ${url}:`, retryErr.message);
        throw retryErr;
      }
    }
    // Full error dump
    console.error(`[Shiprocket Error] HTTP ${err.response?.status || 'ERR'} for ${url}:`, err.response?.data?.message || err.message);
    const msg = err.response?.data?.message || err.message;
    throw new Error(msg);
  }
};

const get  = (url, params) => call('GET',  url, { params });
const post = (url, data)   => call('POST', url, { data });

// ── Auth ──────────────────────────────────────────────────────────────────────
const login = async () => { _token = null; return getToken(); };

// ── Orders ────────────────────────────────────────────────────────────────────
const createOrder  = (body)   => post('/orders/create/adhoc', body);
const updateOrder  = (body)   => post('/orders/update/adhoc', body);
const cancelOrders = (ids)    => post('/orders/cancel', { ids });
const getOrders    = (params) => get('/orders', params);
const getOrder     = (id)     => get(`/orders/show/${id}`);

// ── Courier ───────────────────────────────────────────────────────────────────
const checkServiceability = (params) => {
  const p = { ...params };
  if (p.weight) p.weight = Number(p.weight);
  if (p.cod !== undefined) p.cod = Number(p.cod);
  return get('/courier/serviceability/', p);
};
const getCourierListWithCounts = () => get('/courier/courierListWithCounts');
const assignAWB = async (shipment_id, courier_id) => {
  const token = await getToken();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  // Use raw axios so awb_assign_status:0 responses are NOT thrown as errors
  try {
    const res = await axios({
      method: 'POST',
      url: `${BASE_URL}/courier/assign/awb`,
      headers,
      data: { shipment_id: Number(shipment_id), courier_id: Number(courier_id) },
    });
    return res.data;
  } catch (err) {
    if (err.response?.status === 401) {
      _token = null;
      const fresh = await getToken();
      const res = await axios({
        method: 'POST',
        url: `${BASE_URL}/courier/assign/awb`,
        headers: { Authorization: `Bearer ${fresh}`, 'Content-Type': 'application/json' },
        data: { shipment_id: Number(shipment_id), courier_id: Number(courier_id) },
      });
      return res.data;
    }
    // Return the error body so controller can inspect awb_assign_status
    if (err.response?.data) return err.response.data;
    throw err;
  }
};
const reassignCourier = (body) => post('/courier/reassign', body);

// ── Shipments ─────────────────────────────────────────────────────────────────
const getShipments   = (params) => get('/shipments', params);
const getShipmentsWithDetails = (params) => get('/orders', params);
const getShipment    = (id)     => get(`/shipments/${id}`);
const cancelShipment = (order_ids) => post('/orders/cancel', { ids: order_ids.map(Number) });

// ── Label / Manifest ──────────────────────────────────────────────────────────
const toArr = (v) => (Array.isArray(v) ? v : [v]);
const generateLabel    = (shipment_id) => post('/courier/generate/label',  { shipment_id: toArr(shipment_id) });
const generateManifest = (shipment_id) => post('/manifests/generate',      { shipment_id: toArr(shipment_id) });
const printManifest    = (order_ids)   => post('/manifests/print',         { order_ids:   toArr(order_ids)   });
const printInvoice     = (ids)         => post('/orders/print/invoice',    { ids:         toArr(ids)         });

// ── Pickup ────────────────────────────────────────────────────────────────────
const generatePickup    = (shipment_id) => post('/courier/generate/pickup', { shipment_id: toArr(shipment_id) });
const cancelPickup      = (body)        => post('/courier/cancel/pickup', body);
const getPickupLocations = ()           => get('/settings/company/pickup');

// ── Tracking ──────────────────────────────────────────────────────────────────
const trackByAWB      = (awb) => get(`/courier/track/awb/${awb}`);
const trackByShipment = (id)  => get(`/courier/track/shipment/${id}`);
const trackBulk       = (awbs) => post(`/courier/track/awbs`, { awbs: Array.isArray(awbs) ? awbs : [awbs] });

// ── Returns ───────────────────────────────────────────────────────────────────
const createReturn = (body)   => post('/orders/create/return', body);
const getReturns   = (params) => get('/orders/processing/return', params);

// ── Wallet ────────────────────────────────────────────────────────────────────
const getWalletBalance      = ()       => get('/account/details/wallet-balance');
const getWalletTransactions = () => ({ data: [] });

// ── NDR ───────────────────────────────────────────────────────────────────────
const getNDR      = (params) => get('/ndr/all', params);
const ndrAction   = (body)   => post('/ndr/action', body);

export default {
  login, getToken,
  createOrder, updateOrder, cancelOrders, getOrders, getOrder,
  checkServiceability, getCourierListWithCounts, assignAWB, reassignCourier,
  getShipments, getShipmentsWithDetails, getShipment, cancelShipment,
  generateLabel, generateManifest, printManifest, printInvoice,
  generatePickup, cancelPickup, getPickupLocations,
  trackByAWB, trackByShipment, trackBulk,
  createReturn, getReturns,
  getWalletBalance, getWalletTransactions,
  getNDR, ndrAction,
};

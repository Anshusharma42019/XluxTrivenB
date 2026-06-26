import axios from 'axios';
import ApiError from '../../utils/ApiError.js';

const BASE_URL = process.env.SHIPMAXX_BASE_URL || 'https://appapi.losung360.com/external/v1';
const AUTH_URL = process.env.SHIPMAXX_AUTH_URL || 'https://appapi.losung360.com/external/v1';

let _email;
let _password;
let _apiKey;
let _tokenExpiresAt = 0;   // Unix ms — when the cached token expires
let _loginPromise = null;   // Guards against concurrent login attempts
let _dynamicAuthUrl;

export const setAuthUrl = (url) => {
  _dynamicAuthUrl = url;
};

export const setCredentials = (email, password) => {
  _email = email; _password = password;
};

export const setApiKey = (key) => {
  _apiKey = key;
  _tokenExpiresAt = Date.now() + 23 * 60 * 60 * 1000; // treat manual key as valid for 23h
};

const getAuthHeader = () => {
  if (_apiKey) return `Bearer ${_apiKey}`;
  return '';
};

// Returns true if token is missing or about to expire (within 5 min buffer)
const isTokenExpired = () => !_apiKey || Date.now() >= (_tokenExpiresAt - 5 * 60 * 1000);

const call = async (method, url, options = {}, isRetry = false) => {
  if (isTokenExpired()) {
    // Deduplicate: if a login is already in-flight, wait for it
    if (!_loginPromise) {
      _loginPromise = login().finally(() => { _loginPromise = null; });
    }
    await _loginPromise;
  }

  const headers = {
    Authorization: getAuthHeader(),
    'Content-Type': 'application/json',
  };
  try {
    const res = await axios({ method, url: `${BASE_URL}${url}`, headers, ...options });
    return res.data;
  } catch (err) {
    const msg = err.response?.data?.detail || err.response?.data?.message || err.message;
    const statusCode = err.response?.status || 500;
    
    // If token was rejected by ShipMaxx, clear it so next call re-logs in
    if (statusCode === 401) { 
      _apiKey = null; 
      _tokenExpiresAt = 0; 
      
      // Auto-retry once
      if (!isRetry) {
        return call(method, url, options, true);
      }
      
      // Map ShipMaxx 401 to 502 to avoid triggering the CRM frontend token refresh interceptor
      throw new ApiError(502, `ShipMaxx Auth Failed: ${msg}`);
    }
    
    throw new ApiError(statusCode, msg);
  }
};

const get  = (url, params) => call('GET',  url, { params });
const post = (url, data)   => call('POST', url, { data });
const put  = (url, data)   => call('PUT',  url, { data });

export const login = async () => {
  const email = _email || process.env.SHIPMAXX_EMAIL;
  const password = _password || process.env.SHIPMAXX_PASSWORD;

  const activeAuthUrl = _dynamicAuthUrl || AUTH_URL;
  const targetUrl = `${activeAuthUrl}/auth/login`;
  const payload = { email_id: email, password: password };
  console.log(`[ShipMaxx] POST ${targetUrl} (email: ${email})`);

  try {
    const res = await axios.post(targetUrl, payload, {
      headers: { 'Content-Type': 'application/json' }
    });

    if (res.data && res.data.access_token) {
      _apiKey = res.data.access_token;
      // Token is valid 24h; cache for 23h to give a 1h buffer before expiry
      _tokenExpiresAt = Date.now() + 23 * 60 * 60 * 1000;
      console.log(`[ShipMaxx] Token cached, expires in 23h`);
      return _apiKey;
    }
    throw new ApiError(500, 'Login succeeded but access_token was missing from response');
  } catch (err) {
    const msg = err.response?.data?.detail || err.response?.data?.message || err.message;
    const statusCode = err.response?.status || 500;
    if (statusCode === 429) {
      throw new ApiError(429, 'ShipMaxx rate limit hit. Please wait a minute and try again.');
    }
    if (statusCode === 401) {
      throw new ApiError(401, 'ShipMaxx rejected credentials. Check SHIPMAXX_EMAIL and SHIPMAXX_PASSWORD in .env');
    }
    throw new ApiError(statusCode, `ShipMaxx auth failed: ${msg}`);
  }
};

// ── Orders ────────────────────────────────────────────────────────────────────
export const getOrder       = (order_id) => get(`/orders/${order_id}`);
export const createOrder    = (body)     => post('/orders/create', body);
export const updateOrder    = (order_id, body) => put(`/orders/${order_id}`, body);
export const fetchAllOrders = (params)   => get('/orders', params);

// ── Shipping ──────────────────────────────────────────────────────────────────
export const createShipment = (body) => post('/shipping/create-shipment', body);
export const trackShipment  = (awb)  => get('/shipping/track-shipment', { awb });
export const cancelShipment = (body) => post('/shipping/cancel-shipment', body);
export const checkServiceability = (body) => post('/shipping/serviceability', body);
export const getShipments = (params) => get('/shipping/shipments', params);
export const getShipmentById = (shipment_id) => get(`/shipping/shipments/${shipment_id}`);

// generateLabel: try POST with order_id first (more reliable), fall back to GET with awb
export const generateLabel = async (awbOrOrderId) => {
  // Try POST with order_id body first
  try {
    return await post('/shipping/generate-label', { order_id: String(awbOrOrderId) });
  } catch (e1) {
    // Fall back to GET with awb query param
    try {
      return await get('/shipping/download-label', { awb: awbOrOrderId });
    } catch (e2) {
      // Try GET with order_id query param
      try {
        return await get('/shipping/generate-label', { order_id: awbOrOrderId });
      } catch (e3) {
        // Return what we have from the DB — label URL may be in the order itself
        throw e3;
      }
    }
  }
};

// getManifest: try both POST and GET
export const getManifest = async (awbOrOrderId) => {
  try {
    return await get(`/shipping/manifest/${awbOrOrderId}`);
  } catch (e1) {
    try {
      return await post('/shipping/manifest', { order_id: String(awbOrOrderId) });
    } catch (e2) {
      throw e2;
    }
  }
};

export const downloadLabelPdf = (awb) => call('GET', '/shipping/download-label', { params: { awb }, responseType: 'arraybuffer' });
export const downloadManifestHtml = (awb) => call('GET', `/shipping/manifest/${awb}`, { responseType: 'arraybuffer' });

// ── Warehouses ────────────────────────────────────────────────────────────────
export const getWarehouses = (params) => get('/warehouses', params);
export const createWarehouse = (body) => post('/warehouses/create', body);

// ── NDR ───────────────────────────────────────────────────────────────────────
export const getNdrList = (params) => get('/ndr', params);
export const ndrAction = (ndr_id, body) => post(`/ndr/${ndr_id}/action`, body);
export const ndrBulkAction = (body) => post('/ndr/bulk-action', body);

// ── Invoice ───────────────────────────────────────────────────────────────────
export const getInvoice = (order_id) => call('GET', `/invoice/order/${order_id}`, { responseType: 'arraybuffer' });

export default {
  login, setCredentials, setApiKey, setAuthUrl,
  getOrder, createOrder, updateOrder, fetchAllOrders,
  createShipment, trackShipment, generateLabel, getManifest,
  cancelShipment, checkServiceability, getShipments, getShipmentById,
  getWarehouses, createWarehouse,
  getNdrList, ndrAction, ndrBulkAction,
  getInvoice, downloadLabelPdf, downloadManifestHtml
};

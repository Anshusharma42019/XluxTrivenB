import catchAsync from '../../utils/catchAsync.js';
import ApiResponse from '../../utils/ApiResponse.js';
import smx from '../shipmaxx/shipmaxx.service.js';

export const setPassword = catchAsync(async (req, res) => {
  const { email, password, api_key, base_url } = req.body;
  if (base_url) {
    smx.setBaseUrl(base_url);
  }
  if (api_key) {
    smx.setApiKey(api_key);
    return res.json(new ApiResponse(200, null, 'ShipMaxx API key updated'));
  }
  if (!email || !password) return res.json(new ApiResponse(400, null, 'email and password required'));
  smx.setCredentials(email, password);
  return res.json(new ApiResponse(200, null, 'ShipMaxx credentials updated'));
});

// In-memory shipping provider setting (persists per server instance)
let activeShippingProvider = 'shiprocket'; // default

export const getShippingProvider = catchAsync(async (req, res) => {
  res.json(new ApiResponse(200, { provider: activeShippingProvider }, 'OK'));
});

export const setShippingProvider = catchAsync(async (req, res) => {
  const { provider } = req.body;
  if (!['shiprocket', 'shipmaxx'].includes(provider))
    return res.json(new ApiResponse(400, null, 'Invalid provider'));
  activeShippingProvider = provider;
  res.json(new ApiResponse(200, { provider }, 'Shipping provider updated'));
});

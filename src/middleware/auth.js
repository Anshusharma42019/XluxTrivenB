import jwt from 'jsonwebtoken';
import { config } from '../config/config.js';
import ApiError from '../utils/ApiError.js';
import catchAsync from '../utils/catchAsync.js';

/**
 * Middleware to protect routes and check roles.
 */
const auth = (...requiredRoles) => catchAsync(async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.warn(`[Auth] No Bearer token found in request: ${req.method} ${req.originalUrl}`);
    throw new ApiError(401, 'Please authenticate');
  }

  const token = authHeader.split(' ')[1];
  let decoded;
  try {
    decoded = jwt.verify(token, config.jwt.secret);
  } catch (error) {
    console.error(`[Auth] Token verification failed for ${req.method} ${req.originalUrl}:`, error.message);
    throw new ApiError(401, 'Invalid or expired token');
  }

  // Use role from token to avoid a DB call on every request
  if (requiredRoles.length && !requiredRoles.includes(decoded.role)) {
    throw new ApiError(403, 'Forbidden');
  }

  req.user = { _id: decoded.sub, role: decoded.role };
  next();
});

export default auth;

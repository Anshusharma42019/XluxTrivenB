import { cache } from '../utils/cache.js';

/**
 * Express middleware to cache successful GET requests.
 * Cache key is scoped by route, query parameters, user ID, user role, and user departments.
 * @param {number} ttlSeconds - Time to live in seconds
 */
export const cacheMiddleware = (ttlSeconds = 300) => {
  return (req, res, next) => {
    // Only cache GET requests
    if (req.method !== 'GET') {
      return next();
    }

    // Generate a secure user-scoped key to maintain data separation
    const userKey = req.user
      ? `${req.user._id}-${req.user.role}-${JSON.stringify(req.userDepartments || [])}`
      : 'anonymous';

    // Formulate cache key based on route path, query params and user scope
    const cacheKey = `route:${req.baseUrl || ''}${req.path}:${userKey}:${JSON.stringify(req.query)}`;

    // Try fetching from cache
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
      res.setHeader('X-Cache', 'HIT');
      return res.json(cachedData);
    }

    // Capture response on cache miss
    res.setHeader('X-Cache', 'MISS');
    const originalJson = res.json;

    res.json = function (body) {
      // Restore original json method to prevent nested recursion/side-effects
      res.json = originalJson;
      
      // Cache successful responses only (HTTP 2xx)
      if (res.statusCode >= 200 && res.statusCode < 300) {
        cache.set(cacheKey, body, ttlSeconds);
      }
      
      return res.json(body);
    };

    next();
  };
};

/**
 * Express middleware to invalidate dashboard cache upon any successful mutations (POST, PUT, DELETE, PATCH).
 */
export const cacheInvalidatorMiddleware = (req, res, next) => {
  if (req.method !== 'GET') {
    const originalJson = res.json;
    const originalSend = res.send;
    let invalidated = false;

    const invalidate = () => {
      if (!invalidated && res.statusCode >= 200 && res.statusCode < 300) {
        cache.delPattern('route:/api/v1/dashboard');
        invalidated = true;
      }
    };

    res.json = function (body) {
      res.json = originalJson;
      invalidate();
      return res.json(body);
    };

    res.send = function (body) {
      res.send = originalSend;
      invalidate();
      return res.send(body);
    };
  }
  next();
};

import { z } from 'zod';
import ApiError from '../utils/ApiError.js';

/**
 * Validate request against a Zod schema.
 */
const validate = (schema) => (req, res, next) => {
  const validSchema = z.object(schema);
  const object = Object.keys(schema).reduce((acc, key) => {
    if (req[key] !== undefined) acc[key] = req[key];
    return acc;
  }, {});

  const result = validSchema.safeParse(object);

  if (!result.success) {
    const issues = result.error?.issues || result.error?.errors || [];
    const errorMessage = issues
      .map((issue) => {
        const path = issue.path ? issue.path.join('.') : '';
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join(', ');
    return next(new ApiError(400, errorMessage || 'Validation failed'));
  }

  req.validated = result.data;
  return next();
};

export default validate;

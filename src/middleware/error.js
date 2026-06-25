import mongoose from 'mongoose';
import fs from 'fs';
import httpStatus from 'http-status'; // Note: I should install http-status for better handling
import { config } from '../config/config.js';
import ApiError from '../utils/ApiError.js';

/**
 * Handle errors during development.
 */
const errorConverter = (err, req, res, next) => {
  let error = err;
  
  // On Vercel (or when bundled), instanceof check might fail. Check if it already has isOperational flag.
  if (!(error instanceof ApiError) && typeof error.isOperational === 'undefined') {
    let statusCode = error.statusCode || httpStatus.INTERNAL_SERVER_ERROR;
    let message = error.message || httpStatus[statusCode];
    let isOperational = false;

    // Convert Mongoose Error & MongoDB Error to 400 Bad Request
    if (error instanceof mongoose.Error || error.code === 11000) {
      statusCode = httpStatus.BAD_REQUEST;
      isOperational = true;
      if (error.code === 11000 && error.keyValue) {
        const field = Object.keys(error.keyValue)[0];
        message = `${field.charAt(0).toUpperCase() + field.slice(1)} already exists`;
      }
    }

    error = new ApiError(statusCode, message, isOperational, err.stack);
  }
  next(error);
};

const errorHandler = (err, req, res, next) => {
  let { statusCode, message } = err;
  if (config.env === 'production' && !err.isOperational) {
    statusCode = httpStatus.INTERNAL_SERVER_ERROR;
    message = httpStatus[httpStatus.INTERNAL_SERVER_ERROR];
  }

  res.locals.errorMessage = err.message;

  const response = {
    code: statusCode,
    message,
    ...(config.env === 'development' && { stack: err.stack }),
  };

  if (config.env === 'development') {
    console.error(err);
    try {
      fs.appendFileSync('error.log', new Date().toISOString() + ' ' + err.stack + '\n\n');
    } catch (fsError) {
      console.error('Could not write to error.log (read-only file system?):', fsError.message);
    }
  }

  res.status(statusCode).send(response);
};

export { errorConverter, errorHandler };

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../../.env') });

const envVarsSchema = z.object({
  NODE_ENV: z.enum(['production', 'development', 'test']).default('development'),
  PORT: z.string().transform(Number).default('3000'),
  MONGODB_URL: z.string().describe('MongoDB connection URL'),
  JWT_SECRET: z.string().describe('JWT secret key'),
  JWT_ACCESS_EXPIRATION_MINUTES: z.string().transform(Number).default('30'),
  JWT_REFRESH_EXPIRATION_DAYS: z.string().transform(Number).default('30'),
  CORS_ORIGIN: z.string().default('*'),
  CLOUDINARY_CLOUD_NAME: z.string().optional().default(''),
  CLOUDINARY_API_KEY: z.string().optional().default(''),
  CLOUDINARY_API_SECRET: z.string().optional().default(''),
});

const envVars = envVarsSchema.safeParse(process.env);

if (!envVars.success) {
  throw new Error(`Config validation error: ${envVars.error.message}`);
}

export const config = {
  env: envVars.data.NODE_ENV,
  port: envVars.data.PORT,
  mongoose: {
    url: envVars.data.MONGODB_URL + (envVars.data.NODE_ENV === 'test' ? '-test' : ''),
    options: {
      tlsAllowInvalidCertificates: true,
      maxPoolSize: 20,        // allow up to 20 concurrent DB connections
      minPoolSize: 5,         // keep 5 connections warm
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    },
  },
  jwt: {
    secret: envVars.data.JWT_SECRET,
    accessExpirationMinutes: envVars.data.JWT_ACCESS_EXPIRATION_MINUTES,
    refreshExpirationDays: envVars.data.JWT_REFRESH_EXPIRATION_DAYS,
    resetPasswordExpirationMinutes: 10,
    verifyEmailExpirationMinutes: 10,
  },
  cors: {
    origin: envVars.data.CORS_ORIGIN,
  },
  cloudinary: {
    cloudName: envVars.data.CLOUDINARY_CLOUD_NAME,
    apiKey: envVars.data.CLOUDINARY_API_KEY,
    apiSecret: envVars.data.CLOUDINARY_API_SECRET,
  },
};

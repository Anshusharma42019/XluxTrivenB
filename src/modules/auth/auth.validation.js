import { z } from 'zod';

export const register = {
  body: z.object({
    email: z.string().email(),
    password: z.string().min(5),
    name: z.string(),
  }),
};

export const login = {
  body: z.object({
    role: z.enum(['admin', 'manager', 'sales', 'doctor', 'logistics', 'support']),
    email: z.string().email().optional(),
    phone: z.string().min(7).optional(),
    password: z.string(),
  }),
};

export const refreshToken = {
  body: z.object({
    refreshToken: z.string(),
  }),
};
 
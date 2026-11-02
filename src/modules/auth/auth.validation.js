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
    role: z.enum(['admin', 'manager', 'sales', 'doctor', 'logistics', 'support']).optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
    password: z.string(),
  }),
};

export const refreshToken = {
  body: z.object({
    refreshToken: z.string(),
  }),
};
 
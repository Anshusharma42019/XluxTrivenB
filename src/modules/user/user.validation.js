import { z } from 'zod';

const paramsIdSchema = z.object({
  userId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid user ID format'),
});

export const getUsers = {
  query: z.object({
    name: z.string().optional(),
    role: z.string().optional(),
    sortBy: z.string().optional(),
    limit: z.coerce.number().int().optional(),
    page: z.coerce.number().int().optional(),
  }),
};

export const getUser = {
  params: paramsIdSchema,
};

export const createUser = {
  body: z.object({
    name: z.string(),
    phone: z.string().min(7),
    password: z.string().min(8),
    role: z.enum(['admin', 'manager', 'sales', 'doctor', 'staff', 'logistics', 'support']).optional(),
    departments: z.array(z.enum(['migraine', 'piles'])).optional(),
    baseSalary: z.coerce.number().min(0).optional(),
    specialization: z.string().optional(),
  }),
};

export const updateUser = {
  params: paramsIdSchema,
  body: z.object({
    name: z.string().optional(),
    phone: z.string().min(7).optional(),
    email: z.string().email().optional(),
    password: z.string().min(8).optional(),
    role: z.enum(['admin', 'manager', 'sales', 'doctor', 'staff', 'logistics', 'support']).optional(),
    departments: z.array(z.enum(['migraine', 'piles'])).optional(),
    baseSalary: z.coerce.number().min(0).optional(),
    specialization: z.string().optional(),
  }).refine((data) => Object.keys(data).length > 0, {
    message: 'Must provide at least one field to update',
  }),
};

export const deleteUser = {
  params: paramsIdSchema,
};

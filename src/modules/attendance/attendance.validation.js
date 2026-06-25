import { z } from 'zod';

const paramsIdSchema = z.object({
  attendanceId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid attendance ID format'),
});

export const checkIn = {
  body: z.object({
    notes: z.string().optional(),
    checkInLocation: z.string().optional(),
  }),
};

export const checkOut = {
  body: z.object({
    notes: z.string().optional(),
  }),
};

export const getAttendance = {
  query: z.object({
    userId: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    page: z.coerce.number().int().optional(),
    limit: z.coerce.number().int().optional(),
  }),
};

export const getMyAttendance = {
  query: z.object({
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    page: z.coerce.number().int().optional(),
    limit: z.coerce.number().int().optional(),
  }),
};

export const updateAttendance = {
  params: paramsIdSchema,
  body: z.object({
    status: z.enum(['present', 'absent', 'half_day', 'late']).optional(),
    notes: z.string().optional(),
  }).refine((data) => Object.keys(data).length > 0, {
    message: 'Must provide at least one field to update',
  }),
};

import { z } from 'zod';

const statusEnum = z.enum(['new', 'contacted', 'interested', 'follow_up', 'closed_won', 'closed_lost', 'on_hold', 'old']);
const sourceEnum = z.enum(['website', 'referral', 'social_media', 'cold_call', 'email', 'walk_in', 'other']);
const typeEnum = z.enum(['general', 'ayurveda', 'panchakarma', 'consultation', 'product', 'other']);

export const createLead = {
  body: z.object({
    name: z.string().min(1),
    phone: z.string().min(1),
    email: z.string().email().optional().or(z.literal('')),
    address: z.string().optional(),
    source: sourceEnum.optional(),
    status: statusEnum.optional(),
    type: typeEnum.optional(),
    note: z.string().optional(),
    problem: z.string().optional(),
    revenue: z.number().optional(),
    assignedTo: z.string().optional(),
    department: z.enum(['migraine', 'piles']).optional().or(z.literal('')),
  }),
};

export const updateLead = {
  body: z.object({
    name: z.string().min(1).optional(),
    phone: z.string().min(1).optional(),
    email: z.string().email().optional().or(z.literal('')),
    address: z.string().optional(),
    source: sourceEnum.optional(),
    status: statusEnum.optional(),
    type: typeEnum.optional(),
    note: z.string().optional(),
    problem: z.string().optional(),
    revenue: z.number().optional(),
    assignedTo: z.string().optional(),
    cnp: z.boolean().optional(),
    department: z.enum(['migraine', 'piles']).optional().or(z.literal('')),
  }),
};

export const getLead = {};
export const deleteLead = {};

export const assignLead = {
  body: z.object({ assignedTo: z.string() }),
};

export const getLeads = {
  query: z.object({
    status: statusEnum.optional(),
    source: sourceEnum.optional(),
    assignedTo: z.string().optional(),
    search: z.string().optional(),
    page: z.string().optional(),
    limit: z.string().optional(),
    cnp: z.string().optional(),
    dateFrom: z.string().optional(),
    dateTo: z.string().optional(),
    department: z.string().optional(),
  }),
};

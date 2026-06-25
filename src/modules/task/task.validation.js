import { z } from 'zod';

const typeEnum = z.enum(['call', 'follow_up', 'meeting', 'email', 'task']);
const statusEnum = z.enum(['pending', 'completed', 'overdue', 'cancelled', 'verification', 'cnp', 'interested', 'cancel_call', 'ready_to_shipment', 'new', 'old', 'on_hold', 'closed_lost']);
const priorityEnum = z.enum(['low', 'medium', 'high']);

export const createTask = {
  body: z.object({
    title: z.string().min(1),
    description: z.string().optional(),
    problem: z.string().optional(),
    type: typeEnum.optional(),
    lead: z.string().optional(),
    assignedTo: z.string().optional(),
    dueDate: z.string().optional(),
    priority: priorityEnum.optional(),
    reminderAt: z.string().optional(),
    cityVillageType: z.enum(['city', 'village']).optional(),
    cityVillage: z.string().optional(),
    houseNo: z.string().optional(),
    postOffice: z.string().optional(),
    district: z.string().optional(),
    landmark: z.string().optional(),
    pincode: z.string().optional(),
    state: z.string().optional(),
    age: z.coerce.number().optional(),
    weight: z.coerce.number().optional(),
    height: z.coerce.number().optional(),
    otherProblems: z.string().optional(),
    problemDuration: z.string().optional(),
    price: z.coerce.number().optional(),
    department: z.enum(['migraine', 'piles']).optional().or(z.literal('')),
  }),
};

export const updateTask = {
  params: z.object({ taskId: z.string() }),
  body: z.object({
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    problem: z.string().optional(),
    type: typeEnum.optional(),
    status: statusEnum.optional(),
    dueDate: z.string().optional(),
    priority: priorityEnum.optional(),
    reminderAt: z.string().optional(),
    cityVillageType: z.enum(['city', 'village']).optional(),
    cityVillage: z.string().optional(),
    houseNo: z.string().optional(),
    postOffice: z.string().optional(),
    district: z.string().optional(),
    landmark: z.string().optional(),
    pincode: z.string().optional(),
    state: z.string().optional(),
    age: z.coerce.number().optional(),
    weight: z.coerce.number().optional(),
    height: z.coerce.number().optional(),
    otherProblems: z.string().optional(),
    problemDuration: z.string().optional(),
    price: z.coerce.number().optional(),
    department: z.enum(['migraine', 'piles']).optional().or(z.literal('')),
  }),
};

export const getTask = {
  params: z.object({ taskId: z.string() }),
};

export const deleteTask = {
  params: z.object({ taskId: z.string() }),
};

export const getTasks = {
  query: z.object({
    status: z.string().optional(),
    type: typeEnum.optional(),
    assignedTo: z.string().optional(),
    lead: z.string().optional(),
    date: z.string().optional(),
    page: z.string().optional(),
    limit: z.string().optional(),
  }).passthrough(),
};

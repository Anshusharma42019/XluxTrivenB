import express from 'express';
import auth from '../../middleware/auth.js';
import requireCheckedIn from '../../middleware/requireCheckedIn.js';
import validate from '../../middleware/validate.js';
import departmentFilter from '../../middleware/departmentFilter.js';
import * as taskValidation from './task.validation.js';
import taskController from './task.controller.js';
import Task from './task.model.js';

const router = express.Router();

router.get('/daily', auth('admin', 'manager', 'sales', 'support'), departmentFilter, taskController.getDailyTasks);
router.get('/by-lead/:leadId', auth('admin', 'manager', 'sales', 'support'), departmentFilter, taskController.getTaskByLead);

// Admin-only: remove duplicate tasks for the same lead (keep newest)
router.post('/cleanup-duplicates', auth('admin', 'manager'), async (req, res) => {
  try {
    const duplicates = await Task.aggregate([
      { $match: { isDeleted: false, status: { $in: ['pending', 'overdue'] }, lead: { $ne: null } } },
      { $sort: { createdAt: -1 } },
      { $group: { _id: '$lead', newestId: { $first: '$_id' }, tasks: { $push: '$_id' }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } }
    ]);

    let totalRemoved = 0;
    for (const dup of duplicates) {
      const toDelete = dup.tasks.filter(id => String(id) !== String(dup.newestId));
      if (toDelete.length > 0) {
        await Task.updateMany({ _id: { $in: toDelete } }, { isDeleted: true });
        totalRemoved += toDelete.length;
      }
    }

    res.json({ status: 200, message: `Cleaned up ${totalRemoved} duplicate tasks from ${duplicates.length} leads` });
  } catch (e) {
    res.status(500).json({ status: 500, message: e.message });
  }
});

router
  .route('/')
  .post(auth('admin', 'manager', 'sales', 'support'), departmentFilter, requireCheckedIn, validate(taskValidation.createTask), taskController.createTask)
  .get(auth('admin', 'manager', 'sales', 'support'), departmentFilter, validate(taskValidation.getTasks), taskController.getTasks);

router
  .route('/:taskId')
  .get(auth('admin', 'manager', 'sales', 'support'), departmentFilter, validate(taskValidation.getTask), taskController.getTask)
  .patch(auth('admin', 'manager', 'sales', 'support'), departmentFilter, requireCheckedIn, validate(taskValidation.updateTask), taskController.updateTask)
  .delete(auth('admin', 'manager'), departmentFilter, validate(taskValidation.deleteTask), taskController.deleteTask);

router.post('/:taskId/notes', auth('admin', 'manager', 'sales', 'support'), departmentFilter, requireCheckedIn, taskController.addNote);

export default router;


import express from 'express';
import auth from '../../middleware/auth.js';
import requireCheckedIn from '../../middleware/requireCheckedIn.js';
import validate from '../../middleware/validate.js';
import departmentFilter from '../../middleware/departmentFilter.js';
import * as leadValidation from './lead.validation.js';
import leadController from './lead.controller.js';

const router = express.Router();

// Public route — no token required (website inquiry form)
router.post('/submit', validate(leadValidation.createLead), leadController.submitLead);

// Public route — department-specific (piles / migraine website forms)
router.post('/submit/:department', validate(leadValidation.createLead), leadController.submitLeadForDepartment);



router.get('/test-verifications', async (req, res) => {
  try {
    const Verification = (await import('../../modules/verification/verification.model.js')).default;
    const records = await Verification.find().sort({ createdAt: -1 }).limit(5).lean();
    res.json(records);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin: remove fake debug leads created by old debug code
router.post('/cleanup-debug-leads', auth('admin', 'manager'), async (req, res) => {
  try {
    const Lead = (await import('./lead.model.js')).default;
    const Task = (await import('../task/task.model.js')).default;
    const result = await Lead.updateMany(
      { $or: [{ phone: '0000000000' }, { name: 'RAW WEBHOOK' }], isDeleted: false },
      { isDeleted: true, deletedAt: new Date() }
    );
    // Also hide tasks for those leads
    const fakeleads = await Lead.find({ $or: [{ phone: '0000000000' }, { name: 'RAW WEBHOOK' }] }, '_id').lean();
    if (fakeleads.length > 0) {
      await Task.updateMany({ lead: { $in: fakeleads.map(l => l._id) } }, { isDeleted: true });
    }
    res.json({ status: 200, message: `Cleaned up ${result.modifiedCount} debug leads` });
  } catch (e) {
    res.status(500).json({ status: 500, message: e.message });
  }
});

router
  .route('/')
  .post(auth('admin', 'manager', 'sales', 'support'), departmentFilter, requireCheckedIn, validate(leadValidation.createLead), leadController.createLead)
  .get(auth('admin', 'manager', 'sales', 'support'), departmentFilter, validate(leadValidation.getLeads), leadController.getLeads);

router.patch('/:leadId/assign', auth('admin', 'manager'), departmentFilter, validate(leadValidation.assignLead), leadController.assignLead);
router.patch('/:leadId/cnp', auth('admin', 'manager', 'sales', 'support'), departmentFilter, requireCheckedIn, leadController.markCNP);
router.patch('/:leadId/uncnp', auth('admin', 'manager', 'sales', 'support'), departmentFilter, requireCheckedIn, leadController.unmarkCNP);
router.post('/:leadId/notes', auth('admin', 'manager', 'sales', 'support'), departmentFilter, requireCheckedIn, leadController.addNote);
router.delete('/:leadId/notes/:noteId', auth('admin', 'manager', 'sales', 'support'), departmentFilter, requireCheckedIn, leadController.deleteNote);
router.post('/:leadId/follow-up', auth('admin', 'manager', 'sales', 'support'), departmentFilter, requireCheckedIn, leadController.addFollowUp);
router.patch('/:leadId/next-follow-up', auth('admin', 'manager', 'sales', 'support'), departmentFilter, requireCheckedIn, leadController.setNextFollowUp);
router.get('/export', auth('admin', 'manager'), departmentFilter, leadController.exportLeads);
router.post('/distribute-unassigned', auth('admin', 'manager'), leadController.distributeUnassigned);
router.post('/distribute-absent', auth('admin', 'manager'), leadController.distributeAbsentSales);
router.get('/search-phone', auth('admin', 'manager', 'sales', 'support'), departmentFilter, leadController.searchByPhone);
router.get('/follow-up/list', auth('admin', 'manager', 'sales', 'support'), departmentFilter, leadController.getFollowUpLeads);

router
  .route('/:leadId')
  .get(auth('admin', 'manager', 'sales', 'support'), departmentFilter, validate(leadValidation.getLead), leadController.getLead)
  .patch(auth('admin', 'manager', 'sales', 'support'), departmentFilter, requireCheckedIn, validate(leadValidation.updateLead), leadController.updateLead)
  .delete(auth('admin', 'manager'), departmentFilter, validate(leadValidation.deleteLead), leadController.deleteLead);

export default router;

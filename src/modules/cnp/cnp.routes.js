import express from 'express';
import auth from '../../middleware/auth.js';
import requireCheckedIn from '../../middleware/requireCheckedIn.js';
import departmentFilter from '../../middleware/departmentFilter.js';
import Cnp from './cnp.model.js';

const router = express.Router();



router.get('/', auth('admin', 'manager', 'sales', 'support'), departmentFilter, async (req, res) => {
  try {
    const query = {};
    if (['sales', 'support', 'logistics'].includes(req.user.role)) {
      if (req.userDepartments && req.userDepartments.length > 0) {
        query.$or = [
          { department: { $in: req.userDepartments } },
          { department: null }
        ];
      }
    } else if (req.query.department) {
      query.department = req.query.department;
    }
    const { filter } = req.query;
    if (filter) {
      const now = new Date();
      const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
      if (filter === 'today') {
        query.createdAt = { $gte: startOfDay(now) };
      } else if (filter === 'yesterday') {
        const start = startOfDay(new Date(now - 86400000));
        query.createdAt = { $gte: start, $lt: startOfDay(now) };
      } else if (filter === 'this_week') {
        const day = now.getDay();
        const start = startOfDay(new Date(now - day * 86400000));
        query.createdAt = { $gte: start };
      } else if (filter === 'this_month') {
        query.createdAt = { $gte: new Date(now.getFullYear(), now.getMonth(), 1) };
      }
    }
    const records = await Cnp.find(query)
      .populate('assignedTo', 'name email departments')
      .populate('lead', 'name phone status problem address houseNo cityVillage postOffice landmark district state pincode notes follow_ups next_follow_up department')
      .sort({ createdAt: -1 });

    // Auto-backfill department from assignedTo.departments or lead.department if missing
    const deptUpdates = records.filter(r => !r.department);
    if (deptUpdates.length > 0) {
      await Promise.all(deptUpdates.map(r => {
        const dept = r.lead?.department || r.assignedTo?.departments?.[0] || null;
        r.department = dept;
        return Cnp.updateOne({ _id: r._id }, { $set: { department: dept } });
      }));
    }

    res.json({ status: 200, data: records });
  } catch (e) {
    res.status(500).json({ status: 500, message: e.message });
  }
});

router.patch('/:id/increment', auth('admin', 'manager', 'sales', 'support'), departmentFilter, requireCheckedIn, async (req, res) => {
  try {
    const existing = await Cnp.findById(req.params.id);
    if (!existing) return res.status(404).json({ message: 'Not found' });
    if (existing.cnpCount >= 3) return res.status(400).json({ message: 'Max CNP count reached' });
    const record = await Cnp.findByIdAndUpdate(
      req.params.id,
      { $inc: { cnpCount: 1 }, lastCnpAt: new Date(), $push: { cnpHistory: { clickedAt: new Date() } } },
      { new: true }
    ).populate('assignedTo', 'name email').populate('lead', 'name phone status problem address houseNo cityVillage postOffice landmark district state pincode department');
    res.json({ status: 200, data: record });
  } catch (e) {
    res.status(500).json({ status: 500, message: e.message });
  }
});

router.delete('/:id', auth('admin', 'manager', 'sales', 'support'), departmentFilter, requireCheckedIn, async (req, res) => {
  try {
    await Cnp.findByIdAndDelete(req.params.id);
    res.json({ status: 200, message: 'Deleted' });
  } catch (e) {
    res.status(500).json({ status: 500, message: e.message });
  }
});

export default router;

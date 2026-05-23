const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const isAdmin = require('../middleware/isAdmin');
const User = require('../models/User');
const StudyBlock = require('../models/StudyBlock');
const Exam = require('../models/Exam');
const OTP = require('../models/OTP');
const mongoose = require('mongoose');
const os = require('os');

// Protect all admin routes
router.use(auth, isAdmin);

// GET /api/admin/health - Server + DB health
router.get('/health', async (req, res) => {
  try {
    const dbState = ['disconnected', 'connected', 'connecting', 'disconnecting'];
    const memUsage = process.memoryUsage();

    res.json({
      status: 'ok',
      db: dbState[mongoose.connection.readyState],
      uptime: Math.floor(process.uptime() / 60),
      memory: {
        memoryUsed: Number((memUsage.heapUsed / 1024 / 1024 / 1024).toFixed(2)),
        total: Number((memUsage.heapTotal / 1024 / 1024 / 1024).toFixed(2)),
        rss: Number((memUsage.rss / 1024 / 1024 / 1024).toFixed(2)),
        unit: 'GB'
      },
      cpu: os.loadavg()[0].toFixed(2),
      nodeVersion: process.version,
      timestamp: new Date()
    });
  } catch (err) {
    res.status(500).json({ status: 'error', msg: err.message });
  }
});

// GET /api/admin/metrics - Aggregates only, no PII
router.get('/metrics', async (req, res) => {
  try {
    const now = new Date();
    const last24h = new Date(now - 24 * 60 * 60 * 1000);
    const last7d = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const today = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

    const [
      totalUsers,
      activeUsers24h,
      activeUsers7d,
      totalBlocks,
      completedToday,
      missedToday,
      overdueBlocks,
      totalOtps
    ] = await Promise.all([
      User.countDocuments({}),
      StudyBlock.distinct('user', { updatedAt: { $gte: last24h } }).then(arr => arr.length),
      StudyBlock.distinct('user', { updatedAt: { $gte: last7d } }).then(arr => arr.length),
      StudyBlock.countDocuments({}),
      StudyBlock.countDocuments({ status: 'completed', date: today }),
      StudyBlock.countDocuments({ status: 'missed', date: today }),
      StudyBlock.countDocuments({ status: 'overdue' }),
      OTP.countDocuments({})
    ]);

    res.json({
      users: {
        total: totalUsers,
        active24h: activeUsers24h,
        active7d: activeUsers7d
      },
      blocks: {
        total: totalBlocks,
        completedToday,
        missedToday,
        overdue: overdueBlocks
      },
      otps: {
        active: totalOtps
      },
      timestamp: now
    });
  } catch (err) {
    res.status(500).json({ msg: 'Server error', error: err.message });
  }
});

// GET /api/admin/errors - Cron + scheduler failure detection
router.get('/errors', async (req, res) => {
  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    const stuckOverdue = await StudyBlock.countDocuments({
      status: 'overdue',
      updatedAt: { $lt: oneHourAgo }
    });

    const problemExams = await Exam.aggregate([
      { $unwind: '$syllabusTopics' },
      { $match: { 'syllabusTopics.missedHours': { $gt: 10 } } },
      { $count: 'count' }
    ]);

    res.json({
      cronFailures: stuckOverdue,
      schedulerFailures: problemExams[0]?.count || 0,
      lastChecked: new Date()
    });
  } catch (err) {
    res.status(500).json({ msg: 'Server error', error: err.message });
  }
});

// GET /api/admin/users - List all users
router.get('/users', async (req, res) => {
  try {
    const users = await User.find().select('-password').sort({ createdAt: -1 }).limit(100);
    res.json(users);
  } catch (err) {
    res.status(500).json({ msg: 'Server error', error: err.message });
  }
});

// GET /api/admin/otps - List recent OTPs for debugging
router.get('/otps', async (req, res) => {
  try {
    const otps = await OTP.find().sort({ createdAt: -1 }).limit(50);
    res.json(otps);
  } catch (err) {
    res.status(500).json({ msg: 'Server error', error: err.message });
  }
});

// DELETE /api/admin/user/:id - Delete user
router.delete('/user/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ msg: 'User not found' });
    if (user.role === 'admin') return res.status(403).json({ msg: 'Cannot delete admin' });
    
    await User.findByIdAndDelete(req.params.id);
    res.json({ msg: 'User deleted' });
  } catch (err) {
    res.status(500).json({ msg: 'Server error', error: err.message });
  }
});

// PATCH /api/admin/user/:id/role - Change user role
router.patch('/user/:id/role', async (req, res) => {
  try {
    const { role } = req.body;
    if (!['user', 'admin'].includes(role)) {
      return res.status(400).json({ msg: 'Invalid role' });
    }
    await User.findByIdAndUpdate(req.params.id, { role });
    res.json({ msg: 'Role updated' });
  } catch (err) {
    res.status(500).json({ msg: 'Server error', error: err.message });
  }
});

module.exports = router;

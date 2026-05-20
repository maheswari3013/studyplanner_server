const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const isAdmin = require('../middleware/isAdmin');
const User = require('../models/User');
const StudyBlock = require('../models/StudyBlock');
const Exam = require('../models/Exam');
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
      uptime: Math.floor(process.uptime() / 60), // minutes
      memory: {
        used: Math.round(memUsage.heapUsed / 1024 / 1024), // MB
        total: Math.round(memUsage.heapTotal / 1024 / 1024), // MB
        rss: Math.round(memUsage.rss / 1024 / 1024) // MB
      },
      cpu: os.loadavg()[0].toFixed(2), // 1min load avg
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
      overdueBlocks
    ] = await Promise.all([
      User.countDocuments({}),
      StudyBlock.distinct('user', { updatedAt: { $gte: last24h } }).then(arr => arr.length),
      StudyBlock.distinct('user', { updatedAt: { $gte: last7d } }).then(arr => arr.length),
      StudyBlock.countDocuments({}),
      StudyBlock.countDocuments({ status: 'completed', date: today }),
      StudyBlock.countDocuments({ status: 'missed', date: today }),
      StudyBlock.countDocuments({ status: 'overdue' })
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

    // Cron failure: overdue blocks stuck > 1h means cron didn't reschedule
    const stuckOverdue = await StudyBlock.countDocuments({
      status: 'overdue',
      updatedAt: { $lt: oneHourAgo }
    });

    // Scheduler failure: topics with >10h missed = can't fit in schedule
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

module.exports = router;
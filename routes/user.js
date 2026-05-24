const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const auth = require('../middleware/auth');
const StudyBlock = require('../models/StudyBlock');
const Exam = require('../models/Exam');
const User = require('../models/User');


// GET /api/user/me - Current user profile summary
router.get('/me', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('-password');
    if (!user) return res.status(404).json({ msg: 'User not found' });

    const userObj = user.toObject();
    userObj.hasCalendar = !!user.googleRefreshToken;
    res.json(userObj);
  } catch (err) {
    console.error('User me error:', err.message);
    res.status(500).json({ msg: 'Server error' });
  }
});

// GET /api/user/stats - For dashboard stat cards
router.get('/user/stats', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

    const todayBlocks = await StudyBlock.countDocuments({
      user: userId,
      date: today,
      isBreak: false
    });

    const completedToday = await StudyBlock.countDocuments({
      user: userId,
      date: today,
      completed: true,
      isBreak: false
    });

    const upcomingExams = await Exam.countDocuments({
      user: userId,
      examDate: { $gte: new Date() }
    });

    const totalTopics = await StudyBlock.distinct('topic', {
      user: userId,
      completed: false,
      isBreak: false
    });

    // Simple streak calc: count consecutive days with completed blocks
    let studyStreak = 0;
    let checkDate = new Date();
    while (studyStreak < 365) {
      const dateStr = checkDate.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      const hasCompleted = await StudyBlock.exists({
        user: userId,
        date: dateStr,
        completed: true,
        isBreak: false
      });
      if (!hasCompleted) break;
      studyStreak++;
      checkDate.setDate(checkDate.getDate() - 1);
    }

    res.json({
      todayBlocks,
      completedToday,
      upcomingExams,
      totalTopics: totalTopics.length,
      studyStreak
    });
  } catch (err) {
    console.error('User stats error:', err);
    res.status(500).json({ msg: 'Server error' });
  }
});

// GET /api/user/subject-progress - For Progress Rings
router.get('/user/subject-progress', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const subjects = await StudyBlock.aggregate([
      { $match: { user: new mongoose.Types.ObjectId(userId), isBreak: false } },
      { $group: {
        _id: '$subject',
        planned: { $sum: '$duration' },
        completed: { $sum: { $cond: ['$completed', '$duration', 0] } }
      }},
      { $project: {
        subject: '$_id',
        planned: { $round: [{ $divide: ['$planned', 60] }, 1] },
        completed: { $round: [{ $divide: ['$completed', 60] }, 1] },
        _id: 0
      }}
    ]);
    res.json(subjects);
  } catch (err) {
    console.error('Subject progress error:', err);
    res.status(500).json({ msg: 'Server error' });
  }
});

// GET /api/user/study-logs - For Study Log History
router.get('/user/study-logs', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const logs = await StudyBlock.aggregate([
      { $match: { user: new mongoose.Types.ObjectId(userId), isBreak: false } },
      { $group: {
        _id: '$subject',
        planned: { $sum: '$duration' },
        actual: { $sum: { $ifNull: ['$actualDuration', '$duration'] } }
      }},
      { $project: {
        subject: '$_id',
        planned: { $round: [{ $divide: ['$planned', 60] }, 1] },
        actual: { $round: [{ $divide: ['$actual', 60] }, 1] },
        _id: 0
      }}
    ]);
    res.json(logs);
  } catch (err) {
    console.error('Study logs error:', err);
    res.status(500).json({ msg: 'Server error' });
  }
});

// GET /api/user/confidence - For Confidence Tracker
router.get('/user/confidence', auth, async (req, res) => {
  try {
    const exams = await Exam.find({ user: req.user.id });
    const conf = {};
    exams.forEach(e => conf[e._id] = e.confidenceLevel || 0);
    res.json(conf);
  } catch (err) {
    console.error('Confidence fetch error:', err);
    res.status(500).json({ msg: 'Server error' });
  }
});

module.exports = router;

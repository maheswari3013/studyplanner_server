const router = require('express').Router();
const mongoose = require('mongoose');
const auth = require('../middleware/auth');
const admin = require('../middleware/admin');
const User = require('../models/User');
const Exam = require('../models/Exam');
const StudyBlock = require('../models/StudyBlock');

router.get('/stats', auth, admin, async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const totalExams = await Exam.countDocuments();

    const hoursAgg = await StudyBlock.aggregate([
      { $match: { completed: true, isBreak: false } },
      { $group: {
        _id: null,
        total: { $sum: { $ifNull: ['$actualDuration', '$duration'] } }
      }}
    ]);
    const totalHours = hoursAgg[0]? hoursAgg[0].total / 60 : 0;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const activeToday = await StudyBlock.distinct('userId', {
      loggedAt: { $gte: today }
    });

    res.json({
      totalUsers,
      totalExams,
      totalHours: Number(totalHours.toFixed(1)),
      activeToday: activeToday.length
    });
  } catch (err) {
    console.error('Admin stats error:', err);
    res.status(500).json({ msg: 'Server error' });
  }
});

router.get('/users', auth, admin, async (req, res) => {
  try {
    const users = await User.aggregate([
      {
        $lookup: {
          from: 'exams',
          localField: '_id',
          foreignField: 'userId',
          as: 'exams'
        }
      },
      {
        $lookup: {
          from: 'studyblocks',
          let: { userId: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ['$userId', '$$userId'] },
                completed: true,
                isBreak: false
              }
            },
            {
              $group: {
                _id: null,
                total: { $sum: { $ifNull: ['$actualDuration', '$duration'] } },
                lastActive: { $max: '$loggedAt' }
              }
            }
          ],
          as: 'stats'
        }
      },
      {
        $project: {
          name: 1,
          email: 1,
          createdAt: 1,
          isAdmin: 1,
          examCount: { $size: '$exams' },
          totalHours: {
            $divide: [{ $ifNull: [{ $arrayElemAt: ['$stats.total', 0] }, 0] }, 60]
          },
          lastActive: { $arrayElemAt: ['$stats.lastActive', 0] }
        }
      }
    ]);

    res.json(users);
  } catch (err) {
    console.error('Admin users error:', err);
    res.status(500).json({ msg: 'Server error' });
  }
});

router.delete('/users/:id', auth, admin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ msg: 'Invalid user ID' });
    }

    await Promise.all([
      User.findByIdAndDelete(id),
      Exam.deleteMany({ userId: id }),
      StudyBlock.deleteMany({ userId: id })
    ]);

    res.json({ msg: 'User and all data deleted' });
  } catch (err) {
    console.error('Delete user error:', err);
    res.status(500).json({ msg: 'Server error' });
  }
});

router.post('/users/:id/reset', auth, admin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ msg: 'Invalid user ID' });
    }

    await Promise.all([
      Exam.deleteMany({ userId: id }),
      StudyBlock.deleteMany({ userId: id }),
      User.findByIdAndUpdate(id, { $unset: { subjectConfidence: 1 } })
    ]);

    res.json({ msg: 'User study data reset' });
  } catch (err) {
    console.error('Reset user error:', err);
    res.status(500).json({ msg: 'Server error' });
  }
});

module.exports = router;
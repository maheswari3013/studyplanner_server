const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const auth = require('../middleware/auth');
const Exam = require('../models/Exam');
const StudyBlock = require('../models/StudyBlock');

// GET /api/exams - Get all exams for logged in user
router.get('/', auth, async (req, res) => {
  try {
    const exams = await Exam.find({ userId: req.user._id }).sort({ examDate: 1 });
    res.json(exams);
  } catch (err) {
    console.error('Get exams error:', err.message);
    res.status(500).json({ msg: 'Server error' });
  }
});

// POST /api/exams - Add new exam with validation
router.post('/', auth, async (req, res) => {
  try {
    const {
      subject,
      examDate,
      time,
      location,
      difficulty,
      currentKnowledge,
      priority,
      syllabusTopics,
      availableHours,
      breakRatio
    } = req.body;

    const exam = new Exam({
      userId: req.user._id,
      subject,
      examDate,
      time: time || "09:00",
      location: location || '',
      difficulty: difficulty || 3,
      currentKnowledge: currentKnowledge || 3,
      priority: priority || 3,
      syllabusTopics: syllabusTopics || [],
      availableHours: availableHours || defaultAvailableHours,
      breakRatio: breakRatio || { study: 50, break: 10 }
    });

    await exam.save();
    res.json(exam);
  } catch (err) {
    console.error('Add exam error:', err.message);
    res.status(500).json({ msg: err.message });
  }
});

// PUT /api/exams/:id - Update exam
router.put('/:id', auth, async (req, res) => {
  try {
    const exam = await Exam.findOne({ _id: req.params.id, user: req.user.id });
    if (!exam) return res.status(404).json({ msg: 'Exam not found' });

    const updates = req.body;
    Object.assign(exam, updates);
    
    await exam.save();
    res.json(exam);
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server error' });
  }
});

// DELETE /api/exams/:id - Delete exam + its study blocks
router.delete('/:id', auth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ msg: 'Invalid exam ID' });
    }

    const exam = await Exam.findOne({ _id: req.params.id, userId: req.user._id });
    
    if (!exam) {
      return res.status(404).json({ msg: 'Exam not found' });
    }

    // Delete all study blocks for this exam
    await StudyBlock.deleteMany({ 
      userId: req.user._id, 
      subject: exam.subject 
    });

    await Exam.findByIdAndDelete(req.params.id);
    
    res.json({ msg: 'Exam and related study blocks deleted' });
  } catch (err) {
    console.error('Delete exam error:', err);
    res.status(500).json({ msg: 'Server Error', error: err.message });
  }
});

module.exports = router;
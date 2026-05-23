const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const auth = require('../middleware/auth');
const Exam = require('../models/Exam');
const StudyBlock = require('../models/StudyBlock');

// GET /api/exams - Get all exams for logged in user
router.get('/', auth, async (req, res) => {
  try {
    const exams = await Exam.find({ user: req.user.id }).sort({ examDate: 1 });
    res.json(exams);
  } catch (err) {
    console.error('Get exams error:', err.message);
    res.status(500).json({ msg: 'Server error' });
  }
});

// GET /api/exams/:id - Get single exam
router.get('/:id', auth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ msg: 'Invalid exam ID' });
    }
    const exam = await Exam.findOne({ _id: req.params.id, user: req.user.id });
    if (!exam) return res.status(404).json({ msg: 'Exam not found' });
    res.json(exam);
  } catch (err) {
    console.error('Get exam error:', err.message);
    res.status(500).json({ msg: 'Server error' });
  }
});

// POST /api/exams - Create exam
router.post('/', auth, async (req, res) => {
  try {
    const exam = new Exam({
      ...req.body,
      user: req.user.id
    });
    await exam.save();
    res.json(exam);
  } catch (err) {
    console.error('Create exam error:', err.message);
    res.status(400).json({ msg: err.message });
  }
});

// PUT /api/exams/:id - Update exam - MERGED VERSION
router.put('/:id', auth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ msg: 'Invalid exam ID' });
    }

    const { examDate, ...updateData } = req.body;
    
    // Validate exam date not in past
    if (examDate) {
      const selectedDate = new Date(examDate);
      const today = new Date();
      today.setHours(0,0,0,0);
      if (selectedDate < today) {
        return res.status(400).json({ msg: 'Exam date cannot be in the past' });
      }
    }

    const exam = await Exam.findOneAndUpdate(
      { _id: req.params.id, user: req.user.id },
      { ...updateData, ...(examDate && { examDate }) },
      { new: true, runValidators: true }
    );
    
    if (!exam) return res.status(404).json({ msg: 'Exam not found' });
    res.json(exam);
  } catch (err) {
    console.error('Update exam error:', err.message);
    res.status(500).json({ msg: 'Server Error', error: err.message });
  }
});

// DELETE /api/exams/:id - Delete exam + its study blocks
router.delete('/:id', auth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ msg: 'Invalid exam ID' });
    }

    const exam = await Exam.findOne({ _id: req.params.id, user: req.user.id });
    
    if (!exam) {
      return res.status(404).json({ msg: 'Exam not found' });
    }

    // Delete all study blocks for this exam
    const deleteResult = await StudyBlock.deleteMany({ 
      user: req.user.id, 
      subject: exam.subject 
    });

    await Exam.findByIdAndDelete(req.params.id);
    
    res.json({ 
      msg: 'Exam and related study blocks deleted',
      deletedBlocks: deleteResult.deletedCount 
    });
  } catch (err) {
    console.error('Delete exam error:', err);
    res.status(500).json({ msg: 'Server Error', error: err.message });
  }
});

// PATCH /api/exams/:id/confidence - Update confidence level
router.patch('/:id/confidence', auth, async (req, res) => {
  try {
    const { level } = req.body;
    if (level < 0 || level > 4) return res.status(400).json({ msg: 'Level must be 0-4' });
    
    const exam = await Exam.findOneAndUpdate(
      { _id: req.params.id, user: req.user.id },
      { confidenceLevel: level },
      { new: true }
    );
    
    if (!exam) return res.status(404).json({ msg: 'Exam not found' });
    res.json({ success: true, examId: exam._id, level });
  } catch (err) {
    console.error('Confidence update error:', err);
    res.status(500).json({ msg: 'Server Error' });
  }
});

module.exports = router;
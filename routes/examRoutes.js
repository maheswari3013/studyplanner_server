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
    console.log('Incoming exam data:', req.body);
    
    const {
      subject,
      examDate,
      time,
      location,
      difficulty,
      currentKnowledge,
      priority,
      totalHours,
      syllabusTopics,
      availableHours,
      breakRatio,
      color
    } = req.body;

    // VALIDATION: Can't use both totalHours AND per-topic hours
    const hasTopicHours = Array.isArray(syllabusTopics) && 
      syllabusTopics.some(t => typeof t === 'object' && t.hours);
    
    if (totalHours && hasTopicHours) {
      return res.status(400).json({ 
        msg: 'Use either totalHours OR per-topic hours, not both' 
      });
    }

    if (hasTopicHours) {
      for (const t of syllabusTopics) {
        if (!t.name || typeof t.name !== 'string' || !t.name.trim()) {
          return res.status(400).json({ msg: 'Each topic needs a valid name' });
        }
        if (!t.hours || t.hours <= 0) {
          return res.status(400).json({ msg: `Topic "${t.name}" needs hours > 0` });
        }
      }
    }

    if (totalHours && totalHours <= 0) {
      return res.status(400).json({ msg: 'totalHours must be > 0' });
    }

    const exam = new Exam({
      userId: req.user._id,
      subject,
      examDate,
      time: time || "09:00",
      location: location || '',
      color: color || '#3B82F6',
      difficulty: difficulty || 3,
      currentKnowledge: currentKnowledge || 3,
      priority: priority || 3,
      totalHours: totalHours || undefined,
      syllabusTopics: syllabusTopics || [],
      availableHours: availableHours || {
        sun: 4, mon: 4, tue: 4, wed: 4, thu: 4, fri: 4, sat: 6
      },
      breakRatio: breakRatio || { study: 25, break: 5 }
    });

    await exam.save();
    console.log('Saved exam:', exam);
    res.json(exam);
  } catch (err) {
    console.error('Add exam error:', err.message);
    res.status(500).json({ msg: err.message });
  }
});

// PUT /api/exams/:id - Update exam
router.put('/:id', auth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ msg: 'Invalid exam ID' });
    }

    const {
      subject,
      examDate,
      time,
      location,
      difficulty,
      currentKnowledge,
      priority,
      totalHours,
      syllabusTopics,
      availableHours,
      breakRatio,
      color
    } = req.body;

    const hasTopicHours = Array.isArray(syllabusTopics) && 
      syllabusTopics.some(t => typeof t === 'object' && t.hours);
    
    if (totalHours && hasTopicHours) {
      return res.status(400).json({ 
        msg: 'Use either totalHours OR per-topic hours, not both' 
      });
    }

    if (hasTopicHours) {
      for (const t of syllabusTopics) {
        if (!t.name || typeof t.name !== 'string' || !t.name.trim()) {
          return res.status(400).json({ msg: 'Each topic needs a valid name' });
        }
        if (!t.hours || t.hours <= 0) {
          return res.status(400).json({ msg: `Topic "${t.name}" needs hours > 0` });
        }
      }
    }

    const exam = await Exam.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      {
        subject,
        examDate,
        time,
        location,
        color,
        difficulty,
        currentKnowledge,
        priority,
        totalHours: totalHours || undefined,
        syllabusTopics: syllabusTopics || [],
        availableHours,
        breakRatio
      },
      { new: true, runValidators: true }
    );

    if (!exam) return res.status(404).json({ msg: 'Exam not found' });
    res.json(exam);
  } catch (err) {
    console.error('Update exam error:', err.message);
    res.status(500).json({ msg: err.message });
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
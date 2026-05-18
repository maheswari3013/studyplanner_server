const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Exam = require('../models/Exam');
const StudyBlock = require('../models/StudyBlock');

// GET /api/exams - Get all exams for logged in user
router.get('/', auth, async (req, res) => {
  try {
    const exams = await Exam.find({ userId: req.user._id }).sort({ examDate: 1 }); // Changed
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
      difficulty,
      currentKnowledge,
      priority,
      totalHours,
      syllabusTopics,
      availableHours,
      breakRatio
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
      userId: req.user._id, // Changed: req.user.id -> req.user._id
      subject,
      examDate,
      time,
      difficulty,
      currentKnowledge,
      priority,
      totalHours: totalHours || undefined,
      syllabusTopics: syllabusTopics || [],
      availableHours,
      breakRatio
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
    const {
      subject,
      examDate,
      time,
      difficulty,
      currentKnowledge,
      priority,
      totalHours,
      syllabusTopics,
      availableHours,
      breakRatio
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
      { _id: req.params.id, userId: req.user._id }, // Changed
      {
        subject,
        examDate,
        time,
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

// DELETE /api/exams/:id
router.delete('/:id', auth, async (req, res) => {
  try {
    const exam = await Exam.findOneAndDelete({ 
      _id: req.params.id, 
      userId: req.user._id // Changed
    });
    
    if (!exam) return res.status(404).json({ msg: 'Exam not found' });

    await StudyBlock.deleteMany({ examId: req.params.id, userId: req.user._id }); // Changed

    res.json({ msg: 'Exam deleted' });
  } catch (err) {
    console.error('Delete exam error:', err.message);
    res.status(500).send('Server Error');
  }
});

module.exports = router;
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const auth = require('../middleware/auth');
const Block = require('../models/StudyBlock');

const timeToMinutes = (time) => {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
};

const minutesToTime = (minutes) => {
  const normalized = ((minutes % 1440) + 1440) % 1440;
  const hours = Math.floor(normalized / 60);
  const mins = normalized % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
};

const overlaps = (startTime, duration, block) => {
  const start = timeToMinutes(startTime);
  const end = start + duration;
  const blockStart = timeToMinutes(block.time || block.startTime);
  const blockEnd = blockStart + block.duration;
  return start < blockEnd && end > blockStart;
};

const calculateMakeupTime = async (originalBlock, userId) => {
  const now = new Date();
  const today = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const currentTime = now.toLocaleTimeString('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit'
  });
  const date = originalBlock.date >= today ? originalBlock.date : today;
  const originalEnd = timeToMinutes(originalBlock.time || originalBlock.startTime) + originalBlock.duration + 10;
  const startAfter = date === today ? Math.max(originalEnd, timeToMinutes(currentTime) + 10) : originalEnd;

  const existingBlocks = await Block.find({
    user: userId,
    date,
    _id: { $ne: originalBlock._id },
    status: { $nin: ['missed'] }
  }).sort({ time: 1 });

  for (let candidate = startAfter; candidate + originalBlock.duration <= 23 * 60; candidate += 10) {
    const candidateTime = minutesToTime(candidate);
    if (!existingBlocks.some(block => overlaps(candidateTime, originalBlock.duration, block))) {
      return { date, time: candidateTime };
    }
  }

  return { date, time: minutesToTime(Math.min(startAfter, 22 * 60)) };
};

const toFrontendBlock = (block) => {
  const data = block.toObject();
  delete data.missedFromId;
  return data;
};

router.get('/', auth, async (req, res) => {
  try {
    const blocks = await Block.find({ user: req.user._id })
      .select('-missedFromId')
      .sort({ date: 1, time: 1 });
    res.json(blocks);
  } catch (err) {
    console.error('Get blocks error:', err.message);
    res.status(500).json({ msg: 'Server error' });
  }
});

router.patch('/:id/missed', auth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ msg: 'Invalid block ID' });
    }

    const originalBlock = await Block.findOne({ _id: req.params.id, user: req.user._id });
    if (!originalBlock) return res.status(404).json({ msg: 'Block not found' });

    originalBlock.status = 'missed';
    originalBlock.missed = true;
    originalBlock.missedAt = new Date();
    await originalBlock.save();

    const newSlot = await calculateMakeupTime(originalBlock, req.user._id);
    const makeupBlock = await Block.create({
      user: req.user._id,
      examId: originalBlock.examId,
      subject: originalBlock.subject,
      topic: `${originalBlock.topic} (Makeup)`,
      date: newSlot.date,
      time: newSlot.time,
      startTime: newSlot.time,
      duration: originalBlock.duration,
      completed: false,
      missed: false,
      type: originalBlock.type,
      intervalDay: originalBlock.intervalDay,
      isGenerated: originalBlock.isGenerated,
      isBreak: false,
      priority: originalBlock.priority,
      color: originalBlock.color,
      status: 'makeup',
      originalStartTime: originalBlock.startTime,
      missedFromId: originalBlock._id
    });

    res.json({
      success: true,
      originalBlock: toFrontendBlock(originalBlock),
      makeupBlock: toFrontendBlock(makeupBlock)
    });
  } catch (err) {
    console.error('Mark block missed error:', err.message);
    res.status(500).json({ msg: 'Server error' });
  }
});

module.exports = router;

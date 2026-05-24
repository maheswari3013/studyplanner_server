const StudyBlock = require('../models/StudyBlock');

const IST_TIME_ZONE = 'Asia/Kolkata';

const istToUtc = (timeStr) => {
  const [h, m] = timeStr.split(':').map(Number);
  let utcH = h - 5;
  let utcM = m - 30;
  if (utcM < 0) { utcM += 60; utcH -= 1; }
  if (utcH < 0) utcH += 24;
  return `${String(utcH).padStart(2, '0')}:${String(utcM).padStart(2, '0')}`;
};

const toISTDateString = (date = new Date()) => {
  return new Date(date).toLocaleDateString('en-CA', { timeZone: IST_TIME_ZONE });
};

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

const overlaps = (start, duration, block) => {
  const startMin = timeToMinutes(start);
  const endMin = startMin + duration;
  const blockStart = timeToMinutes(block.time);
  const blockEnd = blockStart + block.duration;
  return startMin < blockEnd && endMin > blockStart;
};

const overlapsWithBreakBuffer = (start, duration, existing) => {
  const startMin = timeToMinutes(start);
  const endMin = startMin + duration;
  const existingStart = timeToMinutes(existing.time);
  const existingEnd = existingStart + existing.duration;

  // If either block is a break, we only require no strict overlap (no buffer needed)
  if (existing.isBreak || existing.type === 'Break') {
    return startMin < existingEnd && endMin > existingStart;
  }

  // For two study blocks, we require a 10-minute break between them
  const buffer = 10;
  return startMin < (existingEnd + buffer) && (endMin + buffer) > existingStart;
};

const removeConsecutiveBreaks = async (userId, date) => {
  try {
    const blocks = await StudyBlock.find({
      user: userId,
      date: date,
      missed: false,
      status: { $ne: 'missed' }
    }).sort({ time: 1 });

    const invalidBreakIds = [];
    let lastWasBreak = true;

    for (let i = 0; i < blocks.length; i++) {
      const current = blocks[i];
      const isCurrentBreak = current.isBreak || current.type === 'Break';

      if (isCurrentBreak) {
        if (lastWasBreak) {
          invalidBreakIds.push(current._id);
        } else {
          lastWasBreak = true;
        }
      } else {
        lastWasBreak = false;
      }
    }

    const remainingBlocks = blocks.filter(b => !invalidBreakIds.includes(b._id));
    if (remainingBlocks.length > 0) {
      const lastBlock = remainingBlocks[remainingBlocks.length - 1];
      if (lastBlock.isBreak || lastBlock.type === 'Break') {
        invalidBreakIds.push(lastBlock._id);
      }
    }

    if (invalidBreakIds.length > 0) {
      await StudyBlock.deleteMany({ _id: { $in: invalidBreakIds } });
      console.log(`Cleaned up ${invalidBreakIds.length} invalid/consecutive break blocks on ${date}`);
    }
  } catch (err) {
    console.error('Error removing consecutive breaks:', err);
  }
};

const findSameDaySlot = async (block) => {
  const now = new Date();
  const today = toISTDateString(now);
  const targetDate = block.date >= today ? block.date : today;
  const currentTime = now.toLocaleTimeString('en-GB', {
    timeZone: IST_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit'
  });

  const dayStart = block.date === targetDate
    ? Math.max(timeToMinutes(block.time) + block.duration + 10, timeToMinutes(currentTime) + 10)
    : timeToMinutes(currentTime) + 10;

  const existingBlocks = await StudyBlock.find({
    user: block.user,
    date: targetDate,
    _id: { $ne: block._id },
    missed: false,
    completed: false,
        status: { $nin: ['missed'] }
  }).sort({ time: 1 });

  for (let candidate = dayStart; candidate + block.duration <= 23 * 60; candidate += 10) {
    const time = minutesToTime(candidate);
    if (!existingBlocks.some(existing => overlapsWithBreakBuffer(time, block.duration, existing))) {
      return { date: targetDate, time };
    }
  }

  return null;
};

const rescheduleMissedBlock = async (block) => {
  if (block.isBreak || block.rescheduledFrom) return null;

  const slot = await findSameDaySlot(block);
  if (!slot) return null;

  const newBlock = await StudyBlock.create({
    user: block.user,
    examId: block.examId,
    subject: block.subject,
    topic: `${block.topic} (Makeup)`,
    date: slot.date,
    time: slot.time,
    startTime: istToUtc(slot.time),
    duration: block.duration,
    isGenerated: true,
    isBreak: false,
    type: block.type || 'Study',
    intervalDay: block.intervalDay,
    priority: block.priority,
    color: block.color,
    status: 'pending',
    completed: false,
    missed: false,
    notifiedOverdue: false,
    rescheduledFrom: block._id
  });

  return newBlock;
};

const markMissedAndReschedule = async (block, status = 'missed') => {
  if (block.completed) {
    return { block, newBlock: null, skipped: 'completed' };
  }

  block.missed = status === 'missed';
  block.status = status;
  block.missedAt = new Date();
  block.notifiedOverdue = true;
  await block.save();

  const existingReschedule = await StudyBlock.findOne({
    user: block.user,
    rescheduledFrom: block._id
  });
  const newBlock = existingReschedule || await rescheduleMissedBlock(block);

  return { block, newBlock };
};

const completeBlock = async (req, res) => {
  try {
    const block = await StudyBlock.findOneAndUpdate(
      { _id: req.params.id, user: req.user.id },
      {
        $set: {
          completed: true,
          missed: false,
          status: 'completed',
          completedAt: new Date()
        },
        $unset: { missedAt: 1 }
      },
      { new: true }
    );

    if (!block) return res.status(404).json({ msg: 'Block not found' });
    await removeConsecutiveBreaks(block.user, block.date);
    return res.json(block);
  } catch (err) {
    console.error('Complete route error:', err);
    return res.status(500).json({ msg: err.message });
  }
};

const missBlock = async (req, res) => {
  try {
    const block = await StudyBlock.findOne({ _id: req.params.id, user: req.user.id });
    if (!block) return res.status(404).json({ success: false, msg: 'Block not found' });
    if (block.completed) return res.status(400).json({ success: false, msg: 'Already completed' });
    if (block.missed || block.status === 'missed') return res.status(400).json({ success: false, msg: 'Already marked as missed' });

    // Find and delete the relatable break block starting at the end of the study session
    const [sh, sm] = block.time.split(':').map(Number);
    const endMinutes = sh * 60 + sm + block.duration;
    const breakTimeStr = `${String(Math.floor(endMinutes / 60)).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`;

    await StudyBlock.deleteOne({
      user: block.user,
      date: block.date,
      time: breakTimeStr,
      isBreak: true
    });

    const result = await markMissedAndReschedule(block, 'missed');
    await removeConsecutiveBreaks(block.user, block.date);
    if (result.newBlock) {
      await removeConsecutiveBreaks(block.user, result.newBlock.date);
    }
    return res.json({
      success: true,
      msg: result.newBlock ? 'Marked as missed and rescheduled' : 'Marked as missed',
      block: result.block,
      rescheduledBlock: result.newBlock,
      newBlocksCreated: result.newBlock ? 1 : 0
    });
  } catch (err) {
    console.error('Missed route error:', err);
    return res.status(500).json({ success: false, msg: err.message });
  }
};

const markPastPendingBlocksOverdue = async () => {
  const now = new Date();
  const today = toISTDateString(now);
  const blocks = await StudyBlock.find({
    date: { $lte: today },
    completed: false,
    missed: false,
    isBreak: false,
    status: { $nin: ['completed', 'missed'] }
  });

  const results = [];
  for (const block of blocks) {
    const blockEnd = new Date(`${block.date}T${block.time}:00+05:30`);
    blockEnd.setMinutes(blockEnd.getMinutes() + block.duration);
    if (now > blockEnd) {
      const res = await markMissedAndReschedule(block, 'overdue');
      results.push(res);
      await removeConsecutiveBreaks(block.user, block.date);
      if (res.newBlock) {
        await removeConsecutiveBreaks(block.user, res.newBlock.date);
      }
    }
  }

  return results;
};

module.exports = {
  completeBlock,
  missBlock,
  markMissedAndReschedule,
  markPastPendingBlocksOverdue,
  rescheduleMissedBlock,
  removeConsecutiveBreaks
};

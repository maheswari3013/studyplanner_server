const cron = require('node-cron');
const StudyBlock = require('../models/StudyBlock');

const toISTDateString = (date = new Date()) => {
  return new Date(date).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
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

const getBlockStartDate = (block) => {
  return new Date(`${block.date}T${block.time || block.startTime}:00+05:30`);
};

const getBlockEndDate = (block) => {
  const end = getBlockStartDate(block);
  end.setMinutes(end.getMinutes() + block.duration);
  return end;
};

const overlaps = (startTime, duration, block) => {
  const start = timeToMinutes(startTime);
  const end = start + duration;
  const blockStart = timeToMinutes(block.time || block.startTime);
  const blockEnd = blockStart + block.duration;
  return start < blockEnd && end > blockStart;
};

const findNextAvailableSlot = async (userId, duration, fromDate = new Date()) => {
  const today = toISTDateString(fromDate);
  const currentTime = fromDate.toLocaleTimeString('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit'
  });

  for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
    const date = new Date(fromDate);
    date.setDate(date.getDate() + dayOffset);
    const dateStr = toISTDateString(date);
    const startAfter = dayOffset === 0 ? timeToMinutes(currentTime) + 10 : 9 * 60;
    const existingBlocks = await StudyBlock.find({
      user: userId,
      date: dateStr,
      status: { $nin: ['missed'] }
    }).sort({ time: 1 });

    for (let candidate = startAfter; candidate + duration <= 23 * 60; candidate += 10) {
      const time = minutesToTime(candidate);
      if (!existingBlocks.some(block => overlaps(time, duration, block))) {
        const start = new Date(`${dateStr}T${time}:00+05:30`);
        const end = new Date(start);
        end.setMinutes(end.getMinutes() + duration);
        return { date: dateStr, time, start, end };
      }
    }
  }

  return null;
};

const markMissedAndReschedule = async () => {
  const now = new Date();
  const today = toISTDateString(now);
  const pendingBlocks = await StudyBlock.find({
    status: { $in: ['pending', 'overdue'] },
    date: { $lte: today },
    isBreak: false
  });

  for (const block of pendingBlocks) {
    if (getBlockEndDate(block) >= now) continue;

    const existingMakeup = await StudyBlock.exists({ missedFromId: block._id });

    block.status = 'missed';
    block.missed = true;
    block.missedAt = new Date();
    if (!block.originalStartTime) block.originalStartTime = getBlockStartDate(block);
    await block.save();

    if (existingMakeup) continue;

    const nextSlot = await findNextAvailableSlot(block.user, block.duration, now);
    if (nextSlot) {
      await StudyBlock.create({
        user: block.user,
        examId: block.examId,
        subject: block.subject,
        topic: block.topic,
        date: nextSlot.date,
        time: nextSlot.time,
        startTime: nextSlot.time,
        duration: block.duration,
        status: 'makeup',
        originalStartTime: getBlockStartDate(block),
        missedFromId: block._id,
        isRescheduled: true,
        isBreak: false,
        type: block.type,
        intervalDay: block.intervalDay,
        isGenerated: true,
        priority: block.priority,
        color: block.color
      });
    }
  }
};

cron.schedule('*/5 * * * *', markMissedAndReschedule);

module.exports = { markMissedAndReschedule, findNextAvailableSlot };

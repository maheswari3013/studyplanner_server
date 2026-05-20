const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const connectDB = require('./config/db');
const StudyBlock = require('./models/StudyBlock');
const Exam = require('./models/Exam');
const { generateSchedule } = require('./utils/scheduler');
const errorHandler = require('./middleware/errorHandler');
require('dotenv').config();

connectDB();
const app = express();

const allowedOrigins = [
  'http://localhost:5173',
  'https://studyplanner-client.vercel.app'
];

const corsOptions = {
  origin: function (origin, callback) {
    console.log('Incoming request from origin:', origin);
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin) || origin.endsWith('.vercel.app')) {
      return callback(null, true);
    }
    return callback(new Error(`CORS blocked: ${origin} not allowed`));
  },
  credentials: true,
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Helper: Convert IST "HH:MM" to UTC "HH:MM" for cron
const istToUtc = (timeStr) => {
  const [h, m] = timeStr.split(':').map(Number);
  let utcH = h - 5;
  let utcM = m - 30;
  if (utcM < 0) { utcM += 60; utcH -= 1; }
  if (utcH < 0) utcH += 24;
  return `${String(utcH).padStart(2,'0')}:${String(utcM).padStart(2,'0')}`;
};

// ===== CRON: MARK OVERDUE AS MISSED + AUTO-REGENERATE =====
cron.schedule('*/1 * * * *', async () => { // Every 1 min for faster testing
  try {
    const now = new Date();
    const today = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const currentTime = now.toLocaleTimeString('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit'
    });

    console.log(`[CRON] Running at ${currentTime} IST for date ${today}`);

    const blocks = await StudyBlock.find({
      date: today,
      completed: false,
      missed: false,
      isBreak: false
    });

    console.log(`[CRON] Found ${blocks.length} active blocks to check`);

    const overdueBlocks = [];
    for (const block of blocks) {
      const blockStart = new Date(`${block.date}T${block.time}:00+05:30`);
      const blockEnd = new Date(blockStart);
      blockEnd.setMinutes(blockEnd.getMinutes() + block.duration);

      const blockEndTime = blockEnd.toLocaleTimeString('en-GB', {
        timeZone: 'Asia/Kolkata',
        hour: '2-digit',
        minute: '2-digit'
      });

      console.log(`[CRON] Checking ${block.subject} ${block.time}-${blockEndTime} vs ${currentTime}`);

      if (now > blockEnd) {
        overdueBlocks.push(block);
        console.log(`[CRON] OVERDUE: ${block.subject} ${block.time}`);
      }
    }

    if (overdueBlocks.length === 0) {
      console.log(`[CRON] No overdue blocks`);
      return;
    }

    const userIds = [...new Set(overdueBlocks.map(b => b.userId.toString()))];

    for (const userId of userIds) {
      const userOverdue = overdueBlocks.filter(b => b.userId.toString() === userId);
      const overdueIds = userOverdue.map(b => b._id);

      await StudyBlock.updateMany(
        { _id: { $in: overdueIds } },
        { missed: true }
      );
      console.log(`[CRON] Marked ${userOverdue.length} blocks as missed for user ${userId}`);

      const exams = await Exam.find({ userId });
      if (exams.length === 0) {
        console.log(`[CRON] No exams found for user ${userId}, skipping regenerate`);
        continue;
      }

      const config = {
        startDate: new Date(),
        startHour: 9,
        endHour: 22, // Increased from 18 to give more room for rescheduling
        studyBlock: exams[0]?.breakRatio?.study || 50,
        breakBlock: exams[0]?.breakRatio?.break || 10,
        breakRatio: exams[0]?.breakRatio || { study: 50, break: 10 }
      };

      const existingBlocks = await StudyBlock.find({
        userId,
        date: { $gte: today },
        $or: [
          { isGenerated: false },
          { completed: true },
          { missed: true }
        ]
      });

      await StudyBlock.deleteMany({
        userId,
        date: { $gte: today },
        isGenerated: true,
        completed: false,
        missed: false
      });

      const result = generateSchedule(exams, config, existingBlocks);
      console.log(`[CRON] Regenerate: ${result.schedule?.length || 0} days, conflicts: ${result.conflicts?.length || 0}`);

      if (result.conflicts?.length === 0) {
        const newBlocks = result.schedule.flatMap(d => d.sessions.map(s => ({
          userId,
          subject: s.examName,
          topic: s.topicName,
          date: s.date,
          time: s.startTime,
          startTime: istToUtc(s.startTime),
          duration: s.duration,
          isGenerated: true,
          isBreak: s.isBreak || false,
          type: s.type || 'Study',
          intervalDay: s.intervalDay,
          priority: s.priority,
          color: s.color
        })));

        if (newBlocks.length > 0) {
          await StudyBlock.insertMany(newBlocks);
          console.log(`[CRON] Created ${newBlocks.length} new blocks for user ${userId}`);
        } else {
          console.log(`[CRON] No new blocks to create for user ${userId}`);
        }
      } else {
        console.log(`[CRON] Conflicts detected for user ${userId}:`, result.conflicts);
      }
    }
  } catch (err) {
    console.error('[CRON] Error:', err.message);
  }
});

// Routes
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/exams', require('./routes/examRoutes'));
app.use('/api/schedule', require('./routes/scheduleRoutes'));
app.use('/api/admin', require('./routes/adminRoutes'));
app.use('/api/notifications', require('./routes/notificationRoutes'));

app.get('/', (req, res) => res.send('API Running'));
app.use((req, res, next) => {
  res.status(404).json({
    success: false,
    message: 'Route not found',
    path: req.originalUrl
  });
});
app.use(errorHandler);
require('./utils/reminderScheduler');

const PORT = process.env.PORT || 5000;const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const connectDB = require('./config/db');
const StudyBlock = require('./models/StudyBlock');
const Exam = require('./models/Exam');
const { generateSchedule } = require('./utils/scheduler');
const errorHandler = require('./middleware/errorHandler');
require('dotenv').config();

connectDB();
const app = express();

const allowedOrigins = [
  'http://localhost:5173',
  'https://studyplanner-client.vercel.app'
];

const corsOptions = {
  origin: function (origin, callback) {
    console.log('Incoming request from origin:', origin);
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin) || origin.endsWith('.vercel.app')) {
      return callback(null, true);
    }
    return callback(new Error(`CORS blocked: ${origin} not allowed`));
  },
  credentials: true,
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Helper: Convert IST "HH:MM" to UTC "HH:MM" for cron
const istToUtc = (timeStr) => {
  const [h, m] = timeStr.split(':').map(Number);
  let utcH = h - 5;
  let utcM = m - 30;
  if (utcM < 0) { utcM += 60; utcH -= 1; }
  if (utcH < 0) utcH += 24;
  return `${String(utcH).padStart(2,'0')}:${String(utcM).padStart(2,'0')}`;
};

// ===== CRON: MARK OVERDUE AS MISSED + AUTO-REGENERATE =====
cron.schedule('*/1 * * * *', async () => { // Every 1 min for faster testing
  try {
    const now = new Date();
    const today = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const currentTime = now.toLocaleTimeString('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit'
    });

    console.log(`[CRON] Running at ${currentTime} IST for date ${today}`);

    const blocks = await StudyBlock.find({
      date: today,
      completed: false,
      missed: false,
      isBreak: false
    });

    console.log(`[CRON] Found ${blocks.length} active blocks to check`);

    const overdueBlocks = [];
    for (const block of blocks) {
      const blockStart = new Date(`${block.date}T${block.time}:00+05:30`);
      const blockEnd = new Date(blockStart);
      blockEnd.setMinutes(blockEnd.getMinutes() + block.duration);

      const blockEndTime = blockEnd.toLocaleTimeString('en-GB', {
        timeZone: 'Asia/Kolkata',
        hour: '2-digit',
        minute: '2-digit'
      });

      console.log(`[CRON] Checking ${block.subject} ${block.time}-${blockEndTime} vs ${currentTime}`);

      if (now > blockEnd) {
        overdueBlocks.push(block);
        console.log(`[CRON] OVERDUE: ${block.subject} ${block.time}`);
      }
    }

    if (overdueBlocks.length === 0) {
      console.log(`[CRON] No overdue blocks`);
      return;
    }

    const userIds = [...new Set(overdueBlocks.map(b => b.userId.toString()))];

    for (const userId of userIds) {
      const userOverdue = overdueBlocks.filter(b => b.userId.toString() === userId);
      const overdueIds = userOverdue.map(b => b._id);

      await StudyBlock.updateMany(
        { _id: { $in: overdueIds } },
        { missed: true }
      );
      console.log(`[CRON] Marked ${userOverdue.length} blocks as missed for user ${userId}`);

      const exams = await Exam.find({ userId });
      if (exams.length === 0) {
        console.log(`[CRON] No exams found for user ${userId}, skipping regenerate`);
        continue;
      }

      const config = {
        startDate: new Date(),
        startHour: 9,
        endHour: 22, // Increased from 18 to give more room for rescheduling
        studyBlock: exams[0]?.breakRatio?.study || 50,
        breakBlock: exams[0]?.breakRatio?.break || 10,
        breakRatio: exams[0]?.breakRatio || { study: 50, break: 10 }
      };

      const existingBlocks = await StudyBlock.find({
        userId,
        date: { $gte: today },
        $or: [
          { isGenerated: false },
          { completed: true },
          { missed: true }
        ]
      });

      await StudyBlock.deleteMany({
        userId,
        date: { $gte: today },
        isGenerated: true,
        completed: false,
        missed: false
      });

      const result = generateSchedule(exams, config, existingBlocks);
      console.log(`[CRON] Regenerate: ${result.schedule?.length || 0} days, conflicts: ${result.conflicts?.length || 0}`);

      if (result.conflicts?.length === 0) {
        const newBlocks = result.schedule.flatMap(d => d.sessions.map(s => ({
          userId,
          subject: s.examName,
          topic: s.topicName,
          date: s.date,
          time: s.startTime,
          startTime: istToUtc(s.startTime),
          duration: s.duration,
          isGenerated: true,
          isBreak: s.isBreak || false,
          type: s.type || 'Study',
          intervalDay: s.intervalDay,
          priority: s.priority,
          color: s.color
        })));

        if (newBlocks.length > 0) {
          await StudyBlock.insertMany(newBlocks);
          console.log(`[CRON] Created ${newBlocks.length} new blocks for user ${userId}`);
        } else {
          console.log(`[CRON] No new blocks to create for user ${userId}`);
        }
      } else {
        console.log(`[CRON] Conflicts detected for user ${userId}:`, result.conflicts);
      }
    }
  } catch (err) {
    console.error('[CRON] Error:', err.message);
  }
});

// Routes
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/exams', require('./routes/examRoutes'));
app.use('/api/schedule', require('./routes/scheduleRoutes'));
app.use('/api/admin', require('./routes/adminRoutes'));
app.use('/api/notifications', require('./routes/notificationRoutes'));

app.get('/', (req, res) => res.send('API Running'));
app.use((req, res, next) => {
  res.status(404).json({
    success: false,
    message: 'Route not found',
    path: req.originalUrl
  });
});
app.use(errorHandler);
require('./utils/reminderScheduler');

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
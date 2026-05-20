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
cron.schedule('*/5 * * * *', async () => {
  try {
    const now = new Date();
    const today = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

    const blocks = await StudyBlock.find({
      date: today,
      completed: false,
      missed: false,
      isBreak: false
    });

    const overdueBlocks = [];
    for (const block of blocks) {
      const blockStart = new Date(`${block.date}T${block.time}:00+05:30`);
      const blockEnd = new Date(blockStart);
      blockEnd.setMinutes(blockEnd.getMinutes() + block.duration);

      if (now > blockEnd) {
        overdueBlocks.push(block);
      }
    }

    if (overdueBlocks.length === 0) return;

    // Group by userId to regenerate per user
    const userIds = [...new Set(overdueBlocks.map(b => b.userId.toString()))];

    for (const userId of userIds) {
      const userOverdue = overdueBlocks.filter(b => b.userId.toString() === userId);
      const overdueIds = userOverdue.map(b => b._id);

      // 1. Mark overdue blocks as missed
      await StudyBlock.updateMany(
        { _id: { $in: overdueIds } },
        { missed: true }
      );

      // 2. Get user's exams and config
      const exams = await Exam.find({ userId });
      if (exams.length === 0) continue;

      const config = {
        startDate: new Date(),
        startHour: 9,
        endHour: 18,
        studyBlock: exams[0]?.breakRatio?.study || 50,
        breakBlock: exams[0]?.breakRatio?.break || 10,
        breakRatio: exams[0]?.breakRatio || { study: 50, break: 10 }
      };

      // 3. Get existing blocks - KEEP missed ones so scheduler doesn't double-book those times
      const existingBlocks = await StudyBlock.find({
        userId,
        date: { $gte: today },
        $or: [
          { isGenerated: false },
          { completed: true },
          { missed: true } // Keep missed to avoid scheduling in past slots
        ]
      });

      // 4. Delete ONLY future generated blocks that aren't completed/missed
      await StudyBlock.deleteMany({
        userId,
        date: { $gte: today },
        isGenerated: true,
        completed: false,
        missed: false
      });

      // 5. Regenerate schedule
      const result = generateSchedule(exams, config, existingBlocks);

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
          console.log(` User ${userId}: Marked ${userOverdue.length} overdue as missed, created ${newBlocks.length} new blocks`);
        }
      }
    }
  } catch (err) {
    console.error(' Auto-reschedule error:', err.message);
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
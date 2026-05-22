const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const connectDB = require('./config/db');
const StudyBlock = require('./models/StudyBlock');
const Exam = require('./models/Exam');
const { generateSchedule } = require('./utils/scheduler');
const errorHandler = require('./middleware/errorHandler');
require('dotenv').config();

const app = express();

// ===== CORS CONFIG =====
const allowedOrigins = [
  'http://localhost:5173',
  'https://studyplanner-client.vercel.app',
  'https://studyplanner-api-awmh.onrender.com'
];

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (origin.endsWith('.vercel.app') || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ===== HELPERS =====
const istToUtc = (timeStr) => {
  const [h, m] = timeStr.split(':').map(Number);
  let utcH = h - 5;
  let utcM = m - 30;
  if (utcM < 0) { utcM += 60; utcH -= 1; }
  if (utcH < 0) utcH += 24;
  return `${String(utcH).padStart(2, '0')}:${String(utcM).padStart(2, '0')}`;
};

const calculateDaysToSchedule = (exams) => {
  if (!exams || exams.length === 0) return 1;
  const examDates = exams.map(e => new Date(e.examDate || e.date)).filter(d =>!isNaN(d)).sort((a, b) => a - b);
  if (examDates.length === 0) return 7;
  const firstExamDate = examDates[0];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const examDay = new Date(firstExamDate);
  examDay.setHours(0, 0, 0, 0);
  const dayBeforeExam = new Date(examDay);
  dayBeforeExam.setDate(dayBeforeExam.getDate() - 1);
  const diffTime = dayBeforeExam - today;
  const daysToSchedule = Math.max(1, Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1);
  return daysToSchedule;
};

// ===== CRON JOBS =====
const startCronJobs = () => {
  cron.schedule('*/1 * * * *', async () => {
    try {
      const now = new Date();
      const today = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      const currentTime = now.toLocaleTimeString('en-GB', {
        timeZone: 'Asia/Kolkata',
        hour: '2-digit',
        minute: '2-digit'
      });

      console.log(`Running at ${currentTime} IST for date ${today}`);

      const blocks = await StudyBlock.find({
        date: today,
        completed: false,
        missed: false,
        isBreak: false
      });

      console.log(`Found ${blocks.length} active blocks to check`);

      const overdueBlocks = [];
      for (const block of blocks) {
        const blockStart = new Date(`${block.date}T${block.time}:00+05:30`);
        const blockEnd = new Date(blockStart);
        blockEnd.setMinutes(blockEnd.getMinutes() + block.duration);

        if (now > blockEnd) {
          if (!block.examId) {
            console.log(`SKIP: ${block.subject} ${block.time} - no examId`);
            await StudyBlock.updateOne({ _id: block._id }, { missed: true });
            continue;
          }
          overdueBlocks.push(block);
          console.log(`OVERDUE: ${block.subject} ${block.time}`);
        }
      }

      if (overdueBlocks.length === 0) {
        console.log(`No overdue blocks`);
        return;
      }

      const userIds = [...new Set(overdueBlocks.map(b => b.user.toString()))];

      for (const userId of userIds) {
        try {
          const userOverdue = overdueBlocks.filter(b => b.user.toString() === userId);
          const overdueIds = userOverdue.map(b => b._id);

          await StudyBlock.updateMany({ _id: { $in: overdueIds } }, { missed: true });
          console.log(`Marked ${userOverdue.length} blocks as missed for user ${userId}`);

          const exams = await Exam.find({ user: userId });
          if (exams.length === 0) continue;

          const daysToSchedule = calculateDaysToSchedule(exams);

const config = {
  startDate: new Date(),
  startHour: 0, // Change from 9 to 0 for 24hr default
  endHour: 23, // Change from 18 to 23 for 24hr default
  studyBlock: exams[0]?.breakRatio?.study || 50,
  breakBlock: exams[0]?.breakRatio?.break || 10,
  daysToSchedule: daysToSchedule,
  breakRatio: exams[0]?.breakRatio || { study: 50, break: 10 }
};

          const existingBlocks = await StudyBlock.find({
            user: userId,
            date: { $gte: today },
            $or: [{ isGenerated: false }, { completed: true }, { missed: true }]
          });

          await StudyBlock.deleteMany({
            user: userId,
            date: { $gte: today },
            isGenerated: true,
            completed: false,
            missed: false
          });

          const result = generateSchedule(exams, config, existingBlocks);

          if (result.conflicts?.length === 0) {
            const newBlocks = result.schedule.flatMap(d => d.sessions.map(s => ({
              user: userId,
              examId: exams.find(e => e.subject === s.examName)?._id,
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
              color: s.color,
              completed: false,
              missed: false
            })));

            if (newBlocks.length > 0) {
              await StudyBlock.insertMany(newBlocks);
              console.log(`Created ${newBlocks.length} new blocks for user ${userId}`);
            }
          }
        } catch (userErr) {
          console.error(`Error for user ${userId}:`, userErr.message);
        }
      }
    } catch (err) {
      console.error('Fatal error:', err.message);
    }
  });
};

// ===== ROUTES =====
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/exams', require('./routes/examRoutes'));
app.use('/api/schedule', require('./routes/scheduleRoutes'));
app.use('/api/user', require('./routes/user'));
app.use('/api/admin', require('./routes/adminRoutes'));
app.use('/api/notifications', require('./routes/notificationRoutes'));

app.get('/', (req, res) => res.send('API Running'));
app.get('/api/schedule/test', (req, res) => res.json({ works: true }));
app.use((req, res, next) => {
  res.status(404).json({ success: false, message: 'Route not found', path: req.originalUrl });
});

app.use(errorHandler);

// ===== START SERVER =====
const PORT = process.env.PORT || 5000;

connectDB()
.then(() => {
    console.log('MongoDB connected successfully');
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      startCronJobs();
      require('./utils/reminderScheduler');
    });
  })
.catch((err) => {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  });
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const webpush = require('web-push');
require('dotenv').config();
const connectDB = require('./config/db');
const StudyBlock = require('./models/StudyBlock');
const Exam = require('./models/Exam');
const User = require('./models/User');
const { generateSchedule } = require('./utils/scheduler');
const { markPastPendingBlocksOverdue } = require('./controllers/scheduleController');
const errorHandler = require('./middleware/errorHandler');
const passport = require('./config/passport');

const app = express();

// ===== VAPID CONFIG FOR PUSH =====
webpush.setVapidDetails(
  'mailto:support@studyflow.app',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

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
app.use(passport.initialize());

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
  // 1. OVERDUE CHECK + PUSH NOTIFICATION - every 5 min
  cron.schedule('*/5 * * * *', async () => {
    try {
      const now = new Date();
      const today = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

      const blocks = await StudyBlock.find({
        date: today,
        completed: false,
        missed: false,
        isBreak: false,
        notifiedOverdue: false
      }).populate('user');

      if (blocks.length === 0) {
        console.log('No blocks to check for overdue');
        return;
      }

      console.log(`Checking ${blocks.length} blocks for overdue`);

      for (const block of blocks) {
        const blockStart = new Date(`${block.date}T${block.time}:00+05:30`);
        const blockEnd = new Date(blockStart.getTime() + block.duration * 60000);

        if (now > blockEnd) {
          console.log(`OVERDUE: ${block.subject} ${block.time}`);

          // Mark as overdue + notified; the 1-minute cron handles rescheduling.
          await StudyBlock.updateOne(
            { _id: block._id },
            {
              notifiedOverdue: true,
              missed: false,
              missedAt: new Date(),
              status: 'overdue'
            }
          );

          // Send push notification
          const user = await User.findById(block.user);
          if (user?.pushSubscription) {
            try {
              await webpush.sendNotification(
                user.pushSubscription,
                JSON.stringify({
                  title: '⚠️ Study Block Overdue',
                  body: `${block.subject} - ${block.topic} was missed. Rescheduling...`,
                  icon: '/icon-192.png',
                  badge: '/icon-192.png',
                  data: { url: '/agenda' }
                })
              );
              console.log(`Push sent for ${block.subject}`);
            } catch (err) {
              console.error('Push failed:', err.message);
              if (err.statusCode === 410 || err.statusCode === 404) {
                await User.updateOne({ _id: user._id }, { $unset: { pushSubscription: 1 } });
              }
            }
          }
        }
      }
    } catch (err) {
      console.error('Overdue cron error:', err.message);
    }
  });

  // 2. DAILY PERFORMANCE SUMMARY - 11:30 PM IST
  cron.schedule('30 23 * * *', async () => {
    console.log('Sending daily summaries...');
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

    try {
      const users = await User.find({ pushSubscription: { $exists: true } });

      for (const user of users) {
        const blocks = await StudyBlock.find({
          user: user._id,
          date: today,
          isBreak: false
        });

        if (blocks.length === 0) continue;

        const completed = blocks.filter(b => b.completed).length;
        const missed = blocks.filter(b => b.missed).length;
        const total = blocks.length;
        const percent = Math.round((completed / total) * 100);

        try {
          await webpush.sendNotification(
            user.pushSubscription,
            JSON.stringify({
              title: '📊 Daily Wrap-up',
              body: `${completed}/${total} done - ${percent}%. ${missed} missed. ${percent >= 80? 'Great job!' : 'Tomorrow is a new day!'}`,
              icon: '/icon-192.png',
              badge: '/icon-192.png',
              data: { url: '/agenda' }
            })
          );
          console.log(`Daily summary sent to ${user.email}`);
        } catch (err) {
          console.error('Daily push failed:', err.message);
          if (err.statusCode === 410 || err.statusCode === 404) {
            await User.updateOne({ _id: user._id }, { $unset: { pushSubscription: 1 } });
          }
        }
      }
    } catch (err) {
      console.error('Daily summary cron error:', err.message);
    }
  }, {
    timezone: 'Asia/Kolkata'
  });

  // 3. AUTO-RESCHEDULE CRON - every 1 min
  cron.schedule('*/1 * * * *', async () => {
    try {
      const results = await markPastPendingBlocksOverdue();
      if (results.length > 0) console.log(`Marked/rescheduled ${results.length} overdue blocks`);
    } catch (err) {
      console.error('Reschedule cron error:', err.message);
    }
  });
};

// ===== ROUTES =====
// Redirect legacy/misconfigured Google OAuth callbacks to correct endpoints
app.get('/api/schedule/google/callback', (req, res) => {
  const query = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
  res.redirect(`/api/auth/google/callback${query}`);
});
app.get('/api/schedule/google/calendar/callback', (req, res) => {
  const query = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
  res.redirect(`/api/auth/google/calendar/callback${query}`);
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/exams', require('./routes/examRoutes'));
app.use('/api/schedule', require('./routes/scheduleRoutes'));
app.use('/api/blocks', require('./routes/blockRoutes'));
app.use('/api/user', require('./routes/user'));
app.use('/api/admin', require('./routes/adminRoutes'));
app.use('/api/notifications', require('./routes/notificationRoutes'));
app.use('/api/stats', require('./routes/stats'));

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
      require('./utils/markMissed');
      require('./utils/reminderScheduler');
    });
  })
 .catch((err) => {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  });

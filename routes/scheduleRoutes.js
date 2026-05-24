const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const auth = require('../middleware/auth');
const adminAuth = require('../middleware/isAdmin'); // Error 3: Added admin middleware
const { google } = require('googleapis');
const User = require('../models/User');
const Exam = require('../models/Exam');
const StudyBlock = require('../models/StudyBlock');
const { generateSchedule } = require('../utils/scheduler');
const rateLimit = require('express-rate-limit');
const PDFDocument = require('pdfkit');
const { completeBlock, missBlock, removeConsecutiveBreaks } = require('../controllers/scheduleController');

const pdfLimiter = rateLimit({ windowMs: 60 * 1000, max: 5, message: { msg: 'Too many PDF exports. Try again in 1 minute.' } });
const syncLimiter = rateLimit({ windowMs: 60 * 1000, max: 3, message: { msg: 'Too many syncs. Try again in 1 minute.' } });

const istToUtc = (timeStr) => {
  const [h, m] = timeStr.split(':').map(Number);
  let utcH = h - 5;
  let utcM = m - 30;
  if (utcM < 0) { utcM += 60; utcH -= 1; }
  if (utcH < 0) utcH += 24;
  return `${String(utcH).padStart(2,'0')}:${String(utcM).padStart(2,'0')}`;
};

const getOAuth2Client = () => new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_CALENDAR_CALLBACK || process.env.GOOGLE_CALENDAR_CALLBACK_URL
);

const getGoogleErrorMessage = (err) => {
  const data = err?.response?.data;
  if (typeof data?.error === 'string') return data.error_description || data.error;
  if (data?.error?.message) return data.error.message;
  if (data?.message) return data.message;
  return err.message || 'Google API error';
};

const getStoredGoogleCredentials = (user) => ({
  access_token: user.googleAccessToken || user.googleTokens?.access_token,
  refresh_token: user.googleRefreshToken || user.googleTokens?.refresh_token,
  expiry_date: user.googleTokenExpiry || user.googleTokens?.expiry_date,
  scope: user.googleTokens?.scope,
  token_type: user.googleTokens?.token_type || 'Bearer'
});

// ===== STATIC GET ROUTES FIRST =====

router.get('/', auth, async (req, res) => {
  try {
    const blocks = await StudyBlock.find({ user: req.user.id }).sort({ date: 1, time: 1 });
    res.json(blocks);
  } catch (err) {
    console.error('Schedule fetch error:', err.message);
    res.status(500).json({ msg: 'Server Error' });
  }
});

router.get('/today', auth, async (req, res) => {
  try {
    const now = new Date();
    const today = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const currentTime = now.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });

    const blocks = await StudyBlock.find({
      user: req.user.id,
      date: today
    }).sort({ time: 1 });

    // Error 6: Only auto-mark missed if time has actually passed + 15min grace period
    const updatedBlocks = await Promise.all(blocks.map(async (block) => {
      if (!block.completed &&!block.missed &&!block.isBreak) {
        const [bh, bm] = block.time.split(':').map(Number);
        const [ch, cm] = currentTime.split(':').map(Number);
        const blockMinutes = bh * 60 + bm + block.duration + 15; // 15min grace
        const currentMinutes = ch * 60 + cm;

        if (currentMinutes > blockMinutes) {
          block.missed = true;
          block.missedAt = new Date();
          block.status = 'missed';
          await block.save();
        }
      }
      return block;
    }));

    res.json(updatedBlocks);
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server error' });
  }
});

router.get('/upcoming', auth, async (req, res) => {
  try {
    const exams = await Exam.find({
      user: req.user.id,
      examDate: { $gte: new Date() }
    })
.sort({ examDate: 1 })
.limit(5);
    res.json(exams);
  } catch (err) {
    console.error('Upcoming exams error:', err);
    res.status(500).json({ msg: 'Server Error' });
  }
});

router.get('/user/stats', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

    const todayBlocks = await StudyBlock.find({
      user: userId,
      date: today,
      isBreak: false
    });

    const completedToday = todayBlocks.filter(b => b.completed).length;

    const upcomingExams = await Exam.countDocuments({
      user: userId,
      examDate: { $gte: new Date(), $lte: new Date(Date.now() + 30*24*60*60*1000) }
    });

    const activeTopics = await StudyBlock.distinct('topic', {
      user: userId,
      completed: false,
      isBreak: false
    });

    let studyStreak = 0;
    let checkDate = new Date();
    while (true) {
      const dateStr = checkDate.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      const hasCompleted = await StudyBlock.exists({
        user: userId,
        date: dateStr,
        completed: true,
        isBreak: false
      });
      if (!hasCompleted) break;
      studyStreak++;
      checkDate.setDate(checkDate.getDate() - 1);
      if (studyStreak > 365) break;
    }

    res.json({
      todayBlocks: todayBlocks.length,
      completedToday,
      upcomingExams,
      totalTopics: activeTopics.length,
      studyStreak
    });
  } catch (err) {
    console.error('User stats error:', err);
    res.status(500).json({ msg: 'Server Error' });
  }
});

router.get('/user/subject-progress', auth, async (req, res) => {
  try {
    const subjects = await StudyBlock.aggregate([
      { $match: { user: new mongoose.Types.ObjectId(req.user.id), isBreak: false } },
      { $group: {
          _id: '$subject',
          planned: { $sum: '$duration' },
          completed: { $sum: { $cond: ['$completed', '$duration', 0] } }
      }}
    ]);

    const progress = subjects.map(s => ({
      subject: s._id,
      planned: +(s.planned / 60).toFixed(1),
      completed: +(s.completed / 60).toFixed(1)
    }));

    res.json(progress);
  } catch (err) {
    console.error('Subject progress error:', err);
    res.status(500).json({ msg: 'Server Error' });
  }
});

router.get('/user/study-logs', auth, async (req, res) => {
  try {
    const logs = await StudyBlock.aggregate([
      { $match: { user: new mongoose.Types.ObjectId(req.user.id), isBreak: false, completed: true } },
      { $group: {
          _id: '$subject',
          planned: { $sum: '$duration' },
          actual: { $sum: { $ifNull: ['$actualDuration', '$duration'] } }
      }}
    ]);

    const result = logs.map(l => ({
      subject: l._id,
      planned: +(l.planned / 60).toFixed(1),
      actual: +(l.actual / 60).toFixed(1)
    }));

    res.json(result);
  } catch (err) {
    console.error('Study logs error:', err);
    res.status(500).json({ msg: 'Server Error' });
  }
});

router.get('/user/confidence', auth, async (req, res) => {
  try {
    const exams = await Exam.find({ user: req.user.id });
    const confidenceMap = {};
    exams.forEach(exam => {
      confidenceMap[exam._id] = exam.confidenceLevel || 0;
    });
    res.json(confidenceMap);
  } catch (err) {
    console.error('Confidence fetch error:', err);
    res.status(500).json({ msg: 'Server Error' });
  }
});

router.get('/stats', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const blocks = await StudyBlock.find({ user: userId, isBreak: false });
    let total = 0, completed = 0, missed = 0;
    const bySubject = {};
    blocks.forEach(block => {
      const hours = (block.duration || 0) / 60;
      const subject = block.subject || 'Other';
      total += hours;
      if (block.completed) completed += hours;
      if (block.missed) missed += hours;
      if (!bySubject[subject]) bySubject[subject] = { total: 0, completed: 0 };
      bySubject[subject].total += hours;
      if (block.completed) bySubject[subject].completed += hours;
    });
    const bySubjectArray = Object.entries(bySubject).map(([subject, data]) => ({
      _id: subject,
      total: Number(data.total.toFixed(1)),
      completed: Number(data.completed.toFixed(1))
    }));
    res.json({
      total: Number(total.toFixed(1)),
      completed: Number(completed.toFixed(1)),
      missed: Number(missed.toFixed(1)),
      remaining: Number((total - completed - missed).toFixed(1)),
      completionRate: total > 0? Math.round((completed / total) * 100) : 0,
      bySubject: bySubjectArray
    });
  } catch (err) {
    console.error('Stats error:', err.message);
    res.status(500).json({ msg: 'Server error' });
  }
});

router.get('/exams', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const exams = await Exam.find({ user: userId });
    const examsWithStats = await Promise.all(exams.map(async (exam) => {
      const blocks = await StudyBlock.find({ user: userId, subject: exam.subject, isBreak: false });
      const totalHours = blocks.reduce((sum, b) => sum + b.duration / 60, 0);
      const completedHours = blocks.filter(b => b.completed).reduce((sum, b) => sum + b.duration / 60, 0);
      return {
   ...exam.toObject(),
        totalScheduledHours: Number(totalHours.toFixed(1)),
        completedHours: Number(completedHours.toFixed(1))
      };
    }));
    res.json(examsWithStats);
  } catch (err) {
    res.status(500).json({ msg: 'Server Error' });
  }
});

router.get('/progress', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const subjects = await StudyBlock.aggregate([
      { $match: { user: new mongoose.Types.ObjectId(userId), isBreak: false } },
      { $group: { _id: '$subject', totalPlanned: { $sum: '$duration' }, totalCompleted: { $sum: { $cond: ['$completed', '$duration', 0] } }, totalActual: { $sum: '$actualDuration' } } }
    ]);
    const progress = subjects.map(s => ({
      subject: s._id,
      percentComplete: s.totalPlanned > 0? Math.round((s.totalCompleted / s.totalPlanned) * 100) : 0,
      hoursPlanned: +(s.totalPlanned / 60).toFixed(1),
      hoursCompleted: +(s.totalCompleted / 60).toFixed(1),
      hoursActual: +(s.totalActual / 60).toFixed(1)
    }));
    res.json(progress);
  } catch (err) {
    res.status(500).json({ msg: 'Server Error' });
  }
});

router.get('/readiness', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    const exams = await Exam.find({ user: req.user.id });
    const scores = await Promise.all(exams.map(async exam => {
      const blocks = await StudyBlock.find({ user: req.user.id, subject: exam.subject, isBreak: false });
      const total = blocks.length;
      const done = blocks.filter(b => b.completed).length;
      const completionScore = total > 0? (done / total) * 50 : 0;
      const confidence = user.subjectConfidence?.get(exam.subject) || 5;
      const confidenceScore = (confidence / 10) * 50;
      const daysLeft = Math.ceil((new Date(exam.examDate) - new Date()) / (1000 * 60 * 60 * 24));
      return {
        subject: exam.subject,
        examDate: exam.examDate,
        daysLeft,
        readiness: Math.round(completionScore + confidenceScore),
        completionScore: Math.round(completionScore),
        confidenceScore: Math.round(confidenceScore),
        confidence: confidence
      };
    }));
    res.json(scores);
  } catch (err) {
    res.status(500).json({ msg: 'Server Error' });
  }
});

router.get('/affirmation', auth, async (req, res) => {
  const quotes = [
    "Progress, not perfection.", "Small steps every day lead to big results.",
    "Deep work beats busy work.", "Consistency is your superpower.",
    "One hour of deep focus beats three hours of distraction.",
    "Your future self will thank you for today's effort."
  ];
  const dayIndex = new Date().getDate() % quotes.length;
  res.json({ quote: quotes[dayIndex] });
});

router.get('/export/pdf', auth, pdfLimiter, async (req, res) => {
  try {
    const userId = req.user.id;
    const { start, end } = req.query;
    const startDate = start || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const endDate = end || new Date(Date.now() + 7*86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const blocks = await StudyBlock.find({ user: userId, date: { $gte: startDate, $lte: endDate }, isBreak: false, missed: false }).sort({ date: 1, time: 1 });
    if (blocks.length === 0) return res.status(400).json({ msg: `No study blocks found between ${startDate} and ${endDate}.` });
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=study-schedule-${startDate}.pdf`);
    doc.pipe(res);
    doc.fontSize(20).font('Helvetica-Bold').text('Study Schedule', { align: 'center' });
    doc.fontSize(12).font('Helvetica').text(`${startDate} to ${endDate}`, { align: 'center' });
    doc.moveDown(1.5);
    const daysMap = {};
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    blocks.forEach(b => {
      const d = new Date(b.date + 'T00:00:00');
      const dayKey = b.date;
      if (!daysMap[dayKey]) daysMap[dayKey] = { date: d, dayName: dayNames[d.getDay()], blocks: [] };
      daysMap[dayKey].blocks.push(b);
    });
    const sortedDays = Object.values(daysMap).sort((a, b) => a.date - b.date);
    sortedDays.forEach((day, idx) => {
      if (idx > 0) doc.moveDown(1);
      doc.fontSize(14).font('Helvetica-Bold').text(`${day.dayName}, ${day.date.toLocaleDateString('en-GB')}`, { underline: true });
      doc.moveDown(0.5);
      day.blocks.forEach(block => {
        const color = block.color || '#3B82F6';
        doc.fontSize(10).font('Helvetica-Bold').fillColor(color).text(`${block.time} - ${block.subject}`, { continued: false });
        doc.fontSize(9).font('Helvetica').fillColor('#000000').text(` ${block.topic} • ${block.duration} min • ${block.type}`, { indent: 10 });
        doc.moveDown(0.3);
      });
    });
    doc.end();
  } catch (err) {
    console.error('PDF export error:', err);
    res.status(500).json({ msg: 'Failed to generate PDF', error: err.message });
  }
});

router.get('/export', auth, async (req, res) => {
  try {
    const blocks = await StudyBlock.find({ user: req.user.id, isBreak: false }).sort({ date: 1, time: 1 });
    res.json(blocks);
  } catch (err) {
    res.status(500).json({ msg: 'Server Error' });
  }
});

router.get('/pending', auth, async (req, res) => {
  try {
    const blocks = await StudyBlock.find({
      user: req.user.id,
      completed: false,
      missed: false,
      isBreak: false
    }).sort({ date: 1, time: 1 });
    res.json(blocks);
  } catch (err) {
    console.error('Pending route error:', err.message);
    res.status(500).json({ msg: 'Server error' });
  }
});

// ===== GOOGLE CALENDAR ROUTES =====

router.get('/google/status', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    const credentials = getStoredGoogleCredentials(user);
    const hasCalendarScope = !!(
      user.googleTokens?.scope && 
      (user.googleTokens.scope.includes('auth/calendar') || 
       user.googleTokens.scope.includes('auth/calendar.events'))
    );
    res.json({
      connected: !!credentials.refresh_token && hasCalendarScope
    });
  } catch (err) {
    res.status(500).json({ connected: false });
  }
});

router.get('/google/auth', auth, (req, res) => {
  const oauth2Client = getOAuth2Client();
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/calendar.events'],
    state: req.user.id
  });
  res.json({ url });
});

// ===== ADMIN ROUTES - Request 1 + Error 3 =====
router.get('/admin/users', auth, adminAuth, async (req, res) => {
  try {
    const users = await User.find({}).select('-password -googleTokens');
    const userStats = await Promise.all(users.map(async (user) => {
      const blockCount = await StudyBlock.countDocuments({ user: user._id });
      const examCount = await Exam.countDocuments({ user: user._id });
      return {...user.toObject(), blockCount, examCount };
    }));
    res.json(userStats);
  } catch (err) {
    res.status(500).json({ msg: 'Server Error' });
  }
});

router.get('/admin/stats', auth, adminAuth, async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const totalBlocks = await StudyBlock.countDocuments();
    const totalExams = await Exam.countDocuments();
    const activeUsers = await StudyBlock.distinct('user', {
      createdAt: { $gte: new Date(Date.now() - 7*24*60*60*1000) }
    });
    res.json({
      totalUsers,
      totalBlocks,
      totalExams,
      activeUsers: activeUsers.length
    });
  } catch (err) {
    res.status(500).json({ msg: 'Server Error' });
  }
});

// ===== STATIC POST/DELETE ROUTES =====

router.post('/generate', auth, async (req, res) => {
  try {
    const { exams, startHour = 0, endHour = 23, startDate } = req.body; // Error 7: Default to 0-23

    const userId = req.user.id;
    if (!exams || exams.length === 0) return res.status(400).json({ msg: 'No exams provided' });

    await StudyBlock.deleteMany({ user: userId, isGenerated: true });

    const examDates = exams.map(e => new Date(e.examDate || e.date)).filter(d =>!isNaN(d)).sort((a, b) => a - b);

    const baseDate = startDate? new Date(startDate) : new Date();
    baseDate.setHours(0, 0, 0, 0);

    let daysToSchedule = 7;
    if (examDates.length > 0) {
      const firstExam = new Date(examDates[0]);
      firstExam.setHours(0, 0, 0, 0);
      const diffTime = firstExam - baseDate;
      daysToSchedule = Math.max(1, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));
    }

    const now = new Date();
    const todayStr = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const baseDateStr = baseDate.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const isToday = todayStr === baseDateStr;

    const currentHour = Number(now.toLocaleTimeString('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit'
    }));

    let effectiveStartHour = startHour;
    let effectiveEndHour = endHour;
    let effectiveDays = daysToSchedule;
    let actualStartDate = new Date(baseDate);

    // Handle overnight windows: e.g. 22:00 - 06:00
    const isOvernight = startHour > endHour;
    if (isOvernight) effectiveEndHour = endHour + 24;

    // Error 7: Respect 0-23 range, only shift if today AND current hour > startHour
    if (isToday &&!isOvernight && currentHour >= startHour) {
      effectiveStartHour = currentHour + 1;
      if (effectiveStartHour >= endHour) {
        effectiveStartHour = startHour;
        actualStartDate.setDate(actualStartDate.getDate() + 1);
        effectiveDays = Math.max(1, daysToSchedule - 1);
      }
    }

    const config = {
      startDate: actualStartDate,
      startHour: effectiveStartHour,
      endHour: isOvernight? effectiveEndHour : endHour,
      studyBlock: exams[0]?.breakRatio?.study || 50,
      breakBlock: exams[0]?.breakRatio?.break || 10,
      daysToSchedule: effectiveDays,
      breakRatio: exams[0]?.breakRatio || { study: 50, break: 10 }
    };

    const result = generateSchedule(exams, config, []);

    if (result.conflicts?.length > 0) {
      return res.status(400).json({
        success: false,
        conflicts: result.conflicts,
        msg: `Not enough time: ${effectiveDays} days, ${effectiveStartHour}:00-${endHour}:00`,
        count: 0,
        warnings: result.warnings || []
      });
    }

    const blocksToSave = result.schedule.flatMap(day =>
      day.sessions.map(s => ({
        user: userId,
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
        missed: false,
        status: 'pending'
      }))
    );

    if (blocksToSave.length > 0) {
      await StudyBlock.insertMany(blocksToSave);
    }

    res.json({
      success: true,
      count: blocksToSave.length,
      warnings: result.warnings || [],
      msg: blocksToSave.length > 0
    ? `Generated ${blocksToSave.length} blocks, ${effectiveStartHour}:00-${endHour}:00`
        : `No blocks scheduled for ${actualStartDate.toDateString()} ${effectiveStartHour}:00-${endHour}:00`
    });
  } catch (err) {
    console.error('GENERATE ERROR:', err);
    res.status(500).json({ msg: 'Server error', error: err.message });
  }
});

router.post('/google/sync', auth, syncLimiter, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    const credentials = getStoredGoogleCredentials(user);
    if (!credentials.access_token || !credentials.refresh_token) {
      return res.status(400).json({ success: false, msg: 'Google not connected', needsAuth: true });
    }

    const oauth2Client = getOAuth2Client();
    oauth2Client.setCredentials(credentials);

    try {
      let activeCredentials = credentials;
      const expiresSoon = !activeCredentials.expiry_date || activeCredentials.expiry_date <= Date.now() + 60 * 1000;
      if (expiresSoon) {
        const { credentials: refreshedCredentials } = await oauth2Client.refreshAccessToken();
        activeCredentials = {
          ...activeCredentials,
          ...refreshedCredentials,
          refresh_token: refreshedCredentials.refresh_token || activeCredentials.refresh_token
        };
        await User.findByIdAndUpdate(req.user.id, {
          googleAccessToken: activeCredentials.access_token,
          googleRefreshToken: activeCredentials.refresh_token,
          googleTokenExpiry: activeCredentials.expiry_date,
          googleTokens: activeCredentials
        });
        oauth2Client.setCredentials(activeCredentials);
      }

      const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
      const blocks = await StudyBlock.find({ user: req.user.id, isBreak: false, missed: false, completed: false });
      let synced = 0, errors = 0;
      for (const block of blocks) {
        const start = new Date(`${block.date}T${block.time}:00+05:30`);
        const end = new Date(start);
        end.setMinutes(end.getMinutes() + block.duration);
        const eventData = {
          summary: `${block.subject} - ${block.topic}`,
          description: `StudySync: ${block.type}\nPriority: ${block.priority}\nDuration: ${block.duration}min`,
          start: { dateTime: start.toISOString(), timeZone: 'Asia/Kolkata' },
          end: { dateTime: end.toISOString(), timeZone: 'Asia/Kolkata' },
          colorId: block.priority === 1? '11' : block.type === 'Review'? '5' : '7',
          extendedProperties: { private: { studySyncId: block._id.toString() } }
        };
        try {
          const existing = await calendar.events.list({ calendarId: 'primary', privateExtendedProperty: `studySyncId=${block._id.toString()}`, maxResults: 1 });
          if (existing.data.items.length > 0) {
            await calendar.events.update({ calendarId: 'primary', eventId: existing.data.items[0].id, requestBody: eventData });
          } else {
            await calendar.events.insert({ calendarId: 'primary', requestBody: eventData });
          }
          synced++;
        } catch (e) {
          const eventErrorMessage = getGoogleErrorMessage(e);
          console.error('Google event sync error:', eventErrorMessage);
          if (e?.code >= 400 && e.code < 500) {
            return res.status(e.code).json({ success: false, msg: eventErrorMessage, error: eventErrorMessage });
          }
          errors++;
        }
      }
      return res.json({ success: true, msg: `Synced ${synced} events${errors > 0? `, ${errors} failed` : ''}` });
    } catch (googleErr) {
      const googleMessage = getGoogleErrorMessage(googleErr);
      console.error('Google sync error:', googleMessage);
      const errorCode = googleErr?.response?.data?.error || googleErr?.code || googleMessage;
      const invalidGrant = String(errorCode).includes('invalid_grant');
      const unauthorized = googleErr?.code === 401 || String(errorCode) === '401';
      const isScopeError = googleErr?.code === 403 || String(googleErr?.code) === '403' || String(googleMessage).toLowerCase().includes('scope');
      if (invalidGrant || unauthorized || isScopeError) {
        await User.findByIdAndUpdate(req.user.id, { $unset: { googleTokens: 1, googleAccessToken: 1, googleRefreshToken: 1, googleTokenExpiry: 1 } });
        return res.status(400).json({ success: false, msg: googleMessage, needsAuth: true });
      }
      return res.status(googleErr?.code >= 400 && googleErr.code < 500 ? googleErr.code : 500).json({ success: false, msg: googleMessage, error: googleMessage });
    }
  } catch (err) {
    console.error('Google sync route error:', err);
    res.status(500).json({ success: false, msg: 'Sync failed', error: err.message });
  }
});

router.get('/google/sync', auth, syncLimiter, async (req, res) => {
  try {
    const user = await User.findById(req.user._id || req.user.id);

    if (!user?.googleRefreshToken) {
      return res.status(400).json({
        success: false,
        message: 'Google Calendar not connected',
        action: 'CONNECT_CALENDAR',
        connectUrl: '/api/auth/google/calendar'
      });
    }

    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_CALENDAR_CALLBACK || process.env.GOOGLE_CALENDAR_CALLBACK_URL
    );

    oauth2Client.setCredentials({ refresh_token: user.googleRefreshToken });
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const sevenDaysFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      .toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

    const blocks = await StudyBlock.find({
      user: req.user._id || req.user.id,
      date: { $gte: today, $lte: sevenDaysFromNow },
      isBreak: false,
      missed: false,
      completed: false
    }).sort({ date: 1, time: 1 });

    const events = [];
    for (const block of blocks) {
      const start = new Date(`${block.date}T${block.time}:00+05:30`);
      if (start < new Date()) continue;

      const end = new Date(start);
      end.setMinutes(end.getMinutes() + block.duration);

      const event = {
        summary: `${block.subject || 'Study Block'}${block.topic ? ` - ${block.topic}` : ''}`,
        description: `StudyPlanner block ${block._id}`,
        start: { dateTime: start.toISOString(), timeZone: 'Asia/Kolkata' },
        end: { dateTime: end.toISOString(), timeZone: 'Asia/Kolkata' },
        extendedProperties: { private: { studyPlannerBlockId: block._id.toString() } }
      };

      const created = await calendar.events.insert({
        calendarId: 'primary',
        requestBody: event
      });
      events.push(created.data.id);
    }

    res.json({ success: true, synced: events.length });
  } catch (err) {
    const googleMessage = getGoogleErrorMessage(err);
    console.error('Google Calendar GET sync error:', err.response?.data || err.message);
    const errorCode = err?.response?.data?.error || err?.code || googleMessage;
    const invalidGrant = String(errorCode).includes('invalid_grant');
    const unauthorized = err?.code === 401 || String(errorCode) === '401';
    const isScopeError = err?.code === 403 || String(err?.code) === '403' || String(googleMessage).toLowerCase().includes('scope');
    
    if (invalidGrant || unauthorized || isScopeError) {
      await User.findByIdAndUpdate(req.user._id || req.user.id, {
        $unset: {
          googleTokens: 1,
          googleAccessToken: 1,
          googleRefreshToken: 1,
          googleTokenExpiry: 1
        }
      });
      return res.status(400).json({ success: false, message: googleMessage, needsAuth: true });
    }
    res.status(err?.code >= 400 && err.code < 500 ? err.code : 500).json({ success: false, message: googleMessage });
  }
});

router.delete('/clear-all', auth, async (req, res) => {
  try {
    const result = await StudyBlock.deleteMany({ user: req.user.id });
    res.json({ msg: `Deleted ${result.deletedCount} study blocks` });
  } catch (err) {
    res.status(500).json({ msg: 'Server error', error: err.message });
  }
});

router.delete('/google/disconnect', auth, async (req, res) => {
  await User.findByIdAndUpdate(req.user.id, { $unset: { googleTokens: 1, googleAccessToken: 1, googleRefreshToken: 1, googleTokenExpiry: 1 } });
  res.json({ msg: 'Google Calendar disconnected' });
});

router.patch('/user/confidence', auth, async (req, res) => {
  try {
    const { subject, level } = req.body;
    if (level < 1 || level > 10) return res.status(400).json({ msg: 'Level must be 1-10' });
    const user = await User.findById(req.user.id);
    if (!user.subjectConfidence) user.subjectConfidence = new Map();
    user.subjectConfidence.set(subject, level);
    await user.save();
    res.json({ subject, level });
  } catch (err) {
    res.status(500).json({ msg: 'Server Error' });
  }
});

router.patch('/exams/:id/confidence', auth, async (req, res) => {
  try {
    const { level } = req.body;
    if (level < 1 || level > 4) return res.status(400).json({ msg: 'Level must be 1-4' });
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

// ===== PARAMETERIZED ROUTES LAST =====

router.patch('/:id/complete', auth, completeBlock);
router.post('/:id/complete', auth, completeBlock);
router.patch('/:id/missed', auth, missBlock);
router.post('/:id/missed', auth, missBlock);

router.post('/:id/start', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const blockId = req.params.id;
    const block = await StudyBlock.findOne({ _id: blockId, user: userId });
    if (!block) return res.status(404).json({ msg: 'Block not found' });
    if (block.completed || block.missed) return res.status(400).json({ msg: 'Block already completed or missed' });
    const now = new Date();
    const currentTime = now.toLocaleTimeString('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit'
    });
    const today = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const [oldH, oldM] = block.time.split(':').map(Number);
    const [newH, newM] = currentTime.split(':').map(Number);
    const oldMinutes = oldH * 60 + oldM;
    const newMinutes = newH * 60 + newM;
    const shiftMinutes = newMinutes - oldMinutes;
    if (shiftMinutes <= 0) return res.status(400).json({ msg: 'Cannot start before scheduled time' });
    const futureBlocks = await StudyBlock.find({
      user: userId,
      date: today,
      time: { $gt: block.time },
      _id: { $ne: blockId }
    }).sort({ time: 1 });
    await StudyBlock.updateOne({ _id: blockId }, { time: currentTime, startTime: istToUtc(currentTime) });
    for (const futureBlock of futureBlocks) {
      const [fh, fm] = futureBlock.time.split(':').map(Number);
      const totalMin = fh * 60 + fm + shiftMinutes;
      const newH = Math.floor(totalMin / 60);
      const newM = totalMin % 60;
      const newTime = `${String(newH).padStart(2,'0')}:${String(newM).padStart(2,'0')}`;
      await StudyBlock.updateOne({ _id: futureBlock._id }, { time: newTime, startTime: istToUtc(newTime) });
    }
    res.json({ success: true, msg: `Started at ${currentTime}, shifted ${futureBlocks.length} blocks` });
  } catch (err) {
    console.error('Start block error:', err);
    res.status(500).json({ msg: 'Server Error', error: err.message });
  }
});

router.patch('/:id/pending', auth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ msg: 'Invalid block ID' });
    const block = await StudyBlock.findOneAndUpdate(
      { _id: req.params.id, user: req.user.id },
      { $set: { completed: false, missed: false, status: 'pending' }, $unset: { completedAt: 1, missedAt: 1 } },
      { new: true }
    );
    if (!block) return res.status(404).json({ msg: 'Block not found' });
    
    await removeConsecutiveBreaks(block.user, block.date);
    res.json(block);
  } catch (err) {
    console.error('Pending error:', err);
    res.status(500).json({ msg: 'Server Error' });
  }
});

router.patch('/:id', auth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ msg: 'Invalid block ID' });
    const updateData = {...req.body };
    if (updateData.duration!== undefined) updateData.duration = parseInt(updateData.duration);
    if (updateData.priority!== undefined) updateData.priority = parseInt(updateData.priority);
    if (updateData.time) updateData.startTime = istToUtc(updateData.time);
    delete updateData._id;
    delete updateData.userId;
    const block = await StudyBlock.findOneAndUpdate(
      { _id: req.params.id, user: req.user.id },
      { $set: updateData },
      { new: true, runValidators: true }
    );
    if (!block) return res.status(404).json({ msg: 'Block not found' });
    
    await removeConsecutiveBreaks(block.user, block.date);
    res.json(block);
  } catch (err) {
    console.error('Update error:', err);
    res.status(500).json({ msg: 'Server Error', error: err.message });
  }
});

router.delete('/:id', auth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ msg: 'Invalid block ID' });
    const block = await StudyBlock.findOneAndDelete({ _id: req.params.id, user: req.user.id });
    if (!block) return res.status(404).json({ msg: 'Block not found' });
    
    await removeConsecutiveBreaks(block.user, block.date);
    res.json({ msg: 'Block deleted' });
  } catch (err) {
    console.error('Delete block error:', err);
    res.status(500).json({ msg: 'Server Error' });
  }
});

module.exports = router;

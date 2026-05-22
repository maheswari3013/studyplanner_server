const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const auth = require('../middleware/auth');
const { google } = require('googleapis');
const User = require('../models/User');
const Exam = require('../models/Exam');
const StudyBlock = require('../models/StudyBlock');
const { generateSchedule } = require('../utils/scheduler');
const rateLimit = require('express-rate-limit');
const PDFDocument = require('pdfkit');

const pdfLimiter = rateLimit({ windowMs: 60 * 1000, max: 5, message: { msg: 'Too many PDF exports. Try again in 1 minute.' } });
const syncLimiter = rateLimit({ windowMs: 60 * 1000, max: 3, message: { msg: 'Too many syncs. Try again in 1 minute.' } });

// Helper: Convert IST "HH:MM" to UTC "HH:MM" for cron
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
  process.env.GOOGLE_REDIRECT_URI
);

// ===== STATIC GET ROUTES FIRST =====

// GET /api/schedule - Get all blocks
router.get('/', auth, async (req, res) => {
  try {
    const blocks = await StudyBlock.find({ user: req.user.id }).sort({ date: 1, time: 1 });
    res.json(blocks);
  } catch (err) {
    console.error('Schedule fetch error:', err.message);
    res.status(500).json({ msg: 'Server Error' });
  }
});

// GET /api/schedule/today
router.get('/today', auth, async (req, res) => {
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const blocks = await StudyBlock.find({
      user: req.user.id,
      date: today,
      completed: false,
      missed: false
    }).sort({ time: 1 });
    res.json(blocks);
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server error' });
  }
});

// GET /api/schedule/upcoming
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

// GET /api/schedule/user/stats
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

// GET /api/schedule/user/subject-progress
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

// GET /api/schedule/user/study-logs
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

// GET /api/schedule/user/confidence
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

// GET /api/schedule/stats
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

// GET /api/schedule/exams
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

// GET /api/schedule/progress
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

// GET /api/schedule/readiness
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

// GET /api/schedule/affirmation
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

// GET /api/schedule/export/pdf
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

// GET /api/schedule/export
router.get('/export', auth, async (req, res) => {
  try {
    const blocks = await StudyBlock.find({ user: req.user.id, isBreak: false }).sort({ date: 1, time: 1 });
    res.json(blocks);
  } catch (err) {
    res.status(500).json({ msg: 'Server Error' });
  }
});

// GET /api/schedule/pending
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

// Google Calendar routes
router.get('/google/auth', auth, (req, res) => {
  const oauth2Client = getOAuth2Client();
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/calendar.events'],
    state: req.user.id.toString()
  });
  res.json({ url });
});

router.get('/google/callback', async (req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  try {
    const { code, state } = req.query;
    if (!code ||!state) return res.status(400).send('Missing code or state');
    const oauth2Client = getOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);
    await User.findByIdAndUpdate(state, { googleTokens: tokens });
    res.send(`<script>window.opener.postMessage({type:"GOOGLE_AUTH_SUCCESS"}, "*"); window.close();</script><h2>Connected!</h2>`);
  } catch (err) {
    res.status(500).send(`<h2>Auth failed</h2><p>${err.message}</p>`);
  }
});

// ===== STATIC POST/DELETE ROUTES =====

router.post('/generate', auth, async (req, res) => {
  try {
    const { exams } = req.body;
    const userId = req.user.id;
    if (!exams || exams.length === 0) return res.status(400).json({ msg: 'No exams provided' });
    await StudyBlock.deleteMany({ user: userId, isGenerated: true });
    const examDates = exams.map(e => new Date(e.examDate || e.date)).filter(d =>!isNaN(d)).sort((a, b) => a - b);
    let daysToSchedule = 7;
    if (examDates.length > 0) {
      const firstExamDate = examDates[0];
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const examDay = new Date(firstExamDate);
      examDay.setHours(0, 0, 0, 0);
      const dayBeforeExam = new Date(examDay);
      dayBeforeExam.setDate(dayBeforeExam.getDate() - 1);
      const diffTime = dayBeforeExam - today;
      daysToSchedule = Math.max(1, Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1);
    }
    const now = new Date();
    const currentHour = Number(now.toLocaleTimeString('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit'
    }));
    const config = {
      startDate: new Date(),
      startHour: Math.max(9, currentHour + 1),
      endHour: 23,
      studyBlock: 50,
      breakBlock: 10,
      daysToSchedule: daysToSchedule,
      breakRatio: { study: 50, break: 10 }
    };
    const result = generateSchedule(exams, config, []);
    if (result.conflicts?.length > 0) {
      return res.status(400).json({ success: false, conflicts: result.conflicts, msg: 'Schedule conflicts detected' });
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
        missed: false
      }))
    );
    if (blocksToSave.length > 0) {
      await StudyBlock.insertMany(blocksToSave);
    }
    res.json({ success: true, count: blocksToSave.length, warnings: result.warnings || [] });
  } catch (err) {
    console.error('GENERATE ERROR:', err);
    res.status(500).json({ msg: 'Server error', error: err.message });
  }
});

// POST /api/schedule/google/sync
router.post('/google/sync', auth, syncLimiter, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user.googleTokens?.refresh_token) return res.status(400).json({ msg: 'Connect Google Calendar first', needsAuth: true });
    const oauth2Client = getOAuth2Client();
    oauth2Client.setCredentials(user.googleTokens);
    const { credentials } = await oauth2Client.refreshAccessToken();
    await User.findByIdAndUpdate(req.user.id, { googleTokens: credentials });
    oauth2Client.setCredentials(credentials);
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
      } catch (e) { errors++; }
    }
    res.json({ success: true, msg: `Synced ${synced} events${errors > 0? `, ${errors} failed` : ''}` });
  } catch (err) {
    res.status(500).json({ msg: 'Sync failed', error: err.message });
  }
});

// DELETE /api/schedule/clear-all
router.delete('/clear-all', auth, async (req, res) => {
  try {
    const result = await StudyBlock.deleteMany({ user: req.user.id });
    res.json({ msg: `Deleted ${result.deletedCount} study blocks` });
  } catch (err) {
    res.status(500).json({ msg: 'Server error', error: err.message });
  }
});

// DELETE /api/schedule/google/disconnect
router.delete('/google/disconnect', auth, async (req, res) => {
  await User.findByIdAndUpdate(req.user.id, { $unset: { googleTokens: 1 } });
  res.json({ msg: 'Google Calendar disconnected' });
});

// PATCH /api/schedule/user/confidence
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

// PATCH /api/exams/:id/confidence
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

// PATCH /api/schedule/:id/complete
router.patch('/:id/complete', auth, async (req, res) => {
  try {
    const { actualDuration } = req.body;
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ msg: 'Invalid block ID' });

    const block = await StudyBlock.findOneAndUpdate(
      { _id: req.params.id, user: req.user.id },
      {
        completed: true,
        missed: false,
        status: 'completed',
        actualDuration: actualDuration || null,
        loggedAt: new Date()
      },
      { new: true }
    );

    if (!block) return res.status(404).json({ msg: 'Block not found' });
    res.json(block);
  } catch (err) {
    console.error('Complete error:', err);
    res.status(500).json({ msg: 'Server Error' });
  }
});

// PATCH /api/schedule/:id/missed
router.patch('/:id/missed', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const blockId = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(blockId)) return res.status(400).json({ msg: 'Invalid block ID' });
    const missedBlock = await StudyBlock.findOne({ _id: blockId, user: userId });
    if (!missedBlock) return res.status(404).json({ msg: 'Block not found' });
    if (missedBlock.isBreak) return res.status(400).json({ success: false, msg: 'Breaks cannot be marked as missed' });
    if (missedBlock.status === 'missed') return res.status(400).json({ success: false, msg: 'Already marked as missed' });
    missedBlock.status = 'missed';
    await missedBlock.save();
    const exam = await Exam.findOne({ user: userId, subject: missedBlock.subject });
    if (!exam) return res.status(404).json({ msg: 'Exam not found' });
    const topic = exam.syllabusTopics.find(t => t.name === missedBlock.topic);
    if (topic) {
      topic.missedHours = (topic.missedHours || 0) + (missedBlock.duration / 60);
      await exam.save();
    }
    const exams = await Exam.find({ user: userId });
    const allBlocks = await StudyBlock.find({ user: userId });
    const config = {
      startDate: new Date(),
      startHour: 9,
      endHour: 23,
      studyBlock: exam.breakRatio?.study || 50,
      breakBlock: exam.breakRatio?.break || 10
    };
    const result = generateSchedule(exams, config, allBlocks);
    if (result.conflicts?.length > 0) {
      return res.status(400).json({
        success: false,
        msg: 'Cannot reschedule - insufficient time',
        conflicts: result.conflicts
      });
    }
    const newBlocks = result.schedule.flatMap(d => d.sessions.map(s => ({
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
      status: 'scheduled'
    })));
    if (newBlocks.length > 0) await StudyBlock.insertMany(newBlocks);
    res.json({
      success: true,
      msg: `Marked as missed. Rescheduled ${newBlocks.length} blocks`,
      newBlocksCreated: newBlocks.length
    });
  } catch (err) {
    console.error('Missed block error:', err);
    res.status(500).json({ msg: 'Server Error', error: err.message });
  }
});

// POST /api/schedule/:id/start
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

// PATCH /api/schedule/:id/pending
router.patch('/:id/pending', auth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ msg: 'Invalid block ID' });
    const block = await StudyBlock.findOneAndUpdate(
      { _id: req.params.id, user: req.user.id },
      { completed: false, missed: false },
      { new: true }
    );
    if (!block) return res.status(404).json({ msg: 'Block not found' });
    res.json(block);
  } catch (err) {
    console.error('Pending error:', err);
    res.status(500).json({ msg: 'Server Error' });
  }
});

// PATCH /api/schedule/:id
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
    res.json(block);
  } catch (err) {
    console.error('Update error:', err);
    res.status(500).json({ msg: 'Server Error', error: err.message });
  }
});

// DELETE /api/schedule/:id
router.delete('/:id', auth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ msg: 'Invalid block ID' });
    const block = await StudyBlock.findOneAndDelete({ _id: req.params.id, user: req.user.id });
    if (!block) return res.status(404).json({ msg: 'Block not found' });
    res.json({ msg: 'Block deleted' });
  } catch (err) {
    console.error('Delete block error:', err);
    res.status(500).json({ msg: 'Server Error' });
  }
});

module.exports = router;
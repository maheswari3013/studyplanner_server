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

// Rate limiters - define once at top
const pdfLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5,
  message: { msg: 'Too many PDF exports. Try again in 1 minute.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const syncLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 3,
  message: { msg: 'Too many syncs. Try again in 1 minute.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Helper to create OAuth client
const getOAuth2Client = () => new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// GET /api/schedule - Get all blocks for calendar
router.get('/', auth, async (req, res) => {
  try {
    const blocks = await StudyBlock.find({ userId: req.user._id }).sort({ date: 1, startTime: 1 });
    res.json(blocks);
  } catch (err) {
    console.error('Schedule fetch error:', err.message);
    res.status(500).json({ msg: 'Server Error' });
  }
});

// GET /api/schedule/today
router.get('/today', auth, async (req, res) => {
  try {
    const userId = req.user._id;
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    const blocks = await StudyBlock.find({
      userId,
      date: { $gte: startOfDay, $lte: endOfDay }
    }).sort({ startTime: 1 });

    res.json(blocks);
  } catch (err) {
    console.error('Today route error:', err.message);
    res.status(500).json({ msg: 'Server error' });
  }
});

// GET /api/schedule/stats
router.get('/stats', auth, async (req, res) => {
  try {
    const userId = req.user._id;
    const blocks = await StudyBlock.find({ userId, isBreak: false });

    let total = 0;
    let completed = 0;
    let missed = 0;
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

// GET /api/schedule/exams - with recalculated hours
router.get('/exams', auth, async (req, res) => {
  try {
    const userId = req.user._id;
    const exams = await Exam.find({ userId });
    
    // Recalculate totalScheduledHours from actual StudyBlocks
    const examsWithStats = await Promise.all(exams.map(async (exam) => {
      const blocks = await StudyBlock.find({ 
        userId, 
        subject: exam.subject, 
        isBreak: false 
      });
      
      const totalHours = blocks.reduce((sum, b) => sum + b.duration / 60, 0);
      const completedHours = blocks
        .filter(b => b.completed)
        .reduce((sum, b) => sum + b.duration / 60, 0);
        
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
// POST /api/schedule/generate - Generate study plan
router.post('/generate', auth, async (req, res) => {
  try {
    const { exams, config } = req.body;
    const userId = req.user._id;

    if (!exams || exams.length === 0) {
      return res.status(400).json({ msg: 'No exams provided' });
    }

    await StudyBlock.deleteMany({ userId, isGenerated: true });

    const result = generateSchedule(exams, config, []);

    if (result.conflicts?.length > 0) {
      return res.status(400).json({
        success: false,
        conflicts: result.conflicts,
        msg: 'Schedule conflicts detected'
      });
    }

    const blocksToSave = result.schedule.flatMap(day =>
      day.sessions.map(s => ({
        userId,
        subject: s.examName,
        topic: s.topicName,
        date: s.date,
        startTime: s.startTime,
        duration: s.duration,
        isGenerated: true,
        isBreak: s.isBreak || false,
        type: s.type || 'Study',
        intervalDay: s.intervalDay,
        priority: s.priority,
        color: s.color // ← SAVE COLOR
      }))
    );

    if (blocksToSave.length > 0) {
      await StudyBlock.insertMany(blocksToSave);
    }

    res.json({
      success: true,
      count: blocksToSave.length,
      warnings: result.warnings || []
    });

  } catch (err) {
    console.error('Generate schedule error:', err);
    res.status(500).json({ msg: 'Server error', error: err.message });
  }
});



// GET /api/schedule/export/pdf - Using PDFKit, works on Render
router.get('/export/pdf', auth, pdfLimiter, async (req, res) => {
  try {
    const userId = req.user._id;
    const { start, end } = req.query;

    const startDate = start? new Date(start) : new Date();
    startDate.setHours(0, 0, 0, 0);
    const endDate = end? new Date(end) : new Date(startDate);
    endDate.setDate(endDate.getDate() + 7);
    endDate.setHours(23, 59, 59, 999);

    const blocks = await StudyBlock.find({
      userId,
      date: { $gte: startDate, $lt: endDate },
      isBreak: false,
      missed: false
    }).sort({ date: 1, startTime: 1 });

    if (blocks.length === 0) {
      return res.status(400).json({ 
        msg: `No study blocks found between ${startDate.toLocaleDateString()} and ${endDate.toLocaleDateString()}. Generate a schedule first.` 
      });
    }

    // Create PDF
    const doc = new PDFDocument({ 
      size: 'A4', 
      layout: 'landscape',
      margin: 30 
    });

    // Set response headers
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=study-schedule-${startDate.toISOString().split('T')[0]}.pdf`);
    
    // Pipe PDF to response
    doc.pipe(res);

    // Title
    doc.fontSize(20).font('Helvetica-Bold').text('Study Schedule', { align: 'center' });
    doc.fontSize(12).font('Helvetica').text(
      `${startDate.toLocaleDateString('en-GB')} to ${new Date(endDate.getTime() - 86400000).toLocaleDateString('en-GB')}`, 
      { align: 'center' }
    );
    doc.moveDown(1.5);

    // Group blocks by day
    const daysMap = {};
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    
    blocks.forEach(b => {
      const d = new Date(b.date);
      const dayKey = d.toISOString().split('T')[0];
      if (!daysMap[dayKey]) {
        daysMap[dayKey] = {
          date: d,
          dayName: dayNames[d.getDay()],
          blocks: []
        };
      }
      daysMap[dayKey].blocks.push(b);
    });

    // Sort days
    const sortedDays = Object.values(daysMap).sort((a, b) => a.date - b.date);

    // Draw each day
    sortedDays.forEach((day, idx) => {
      if (idx > 0) doc.moveDown(1);
      
      doc.fontSize(14).font('Helvetica-Bold').text(
        `${day.dayName}, ${day.date.toLocaleDateString('en-GB')}`,
        { underline: true }
      );
      doc.moveDown(0.5);

      day.blocks.forEach(block => {
        const color = block.color || '#3B82F6';
        doc.fontSize(10).font('Helvetica-Bold')
           .fillColor(color)
           .text(`${block.startTime} - ${block.subject}`, { continued: false });
        
        doc.fontSize(9).font('Helvetica')
           .fillColor('#000000')
           .text(`  ${block.topic} • ${block.duration} min • ${block.type}`, { 
             indent: 10 
           });
        doc.moveDown(0.3);
      });
    });

    // Legend
    doc.moveDown(1);
    doc.fontSize(10).font('Helvetica-Bold').text('Subjects:', { underline: true });
    const uniqueSubjects = [...new Set(blocks.map(b => b.subject))];
    uniqueSubjects.forEach(subj => {
      const color = blocks.find(b => b.subject === subj)?.color || '#3B82F6';
      doc.fontSize(9).fillColor(color).text(`• ${subj}`, { indent: 10 });
    });

    doc.end();

  } catch (err) {
    console.error('PDF export error:', err);
    res.status(500).json({ msg: 'Failed to generate PDF', error: err.message });
  }
});
// GET /api/schedule/google/auth - Start OAuth flow
router.get('/google/auth', auth, (req, res) => {
  const oauth2Client = getOAuth2Client();
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/calendar.events'],
    state: req.user._id
  });
  res.json({ url });
});

// GET /api/schedule/google/callback - Handle Google redirect
router.get('/google/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    const userId = state;
    const oauth2Client = getOAuth2Client();

    const { tokens } = await oauth2Client.getToken(code);
    await User.findByIdAndUpdate(userId, { googleTokens: tokens });

    res.send('<script>window.close();</script><h2>Connected! Close this window and click Sync again.</h2>');
  } catch (err) {
    console.error('Google auth error:', err);
    res.status(500).send('Auth failed');
  }
});

// POST /api/schedule/google/sync - Push blocks to calendar
router.post('/google/sync', auth, syncLimiter, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user.googleTokens?.refresh_token) {
      return res.status(400).json({ msg: 'Connect Google Calendar first', needsAuth: true });
    }

    const oauth2Client = getOAuth2Client();
    oauth2Client.setCredentials(user.googleTokens);

    const { credentials } = await oauth2Client.refreshAccessToken();
    await User.findByIdAndUpdate(req.user._id, { googleTokens: credentials });
    oauth2Client.setCredentials(credentials);

    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    const blocks = await StudyBlock.find({
      userId: req.user._id,
      isBreak: false,
      missed: false,
      completed: false
    });

    let synced = 0, errors = 0;
    const userTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

    for (const block of blocks) {
      const start = new Date(block.date);
      const [h, m] = block.startTime.split(':');
      start.setHours(parseInt(h), parseInt(m));

      const end = new Date(start);
      end.setMinutes(end.getMinutes() + block.duration);

      try {
        await calendar.events.insert({
          calendarId: 'primary',
          requestBody: {
            summary: `${block.subject} - ${block.topic}`,
            description: `StudySync: ${block.type}\nPriority: ${block.priority}\nDuration: ${block.duration}min`,
            start: { dateTime: start.toISOString(), timeZone: userTz },
            end: { dateTime: end.toISOString(), timeZone: userTz },
            colorId: block.priority === 1? '11' : block.type === 'Review'? '5' : '7',
            extendedProperties: { private: { studySyncId: block._id.toString() } }
          }
        });
        synced++;
      } catch (e) {
        errors++;
        console.error('Event insert error:', e.message);
      }
    }

    res.json({
      success: true,
      msg: `Synced ${synced} events${errors > 0? `, ${errors} failed` : ''}`
    });
  } catch (err) {
    console.error('Google sync error:', err);
    res.status(500).json({ msg: 'Sync failed', error: err.message });
  }
});

// DELETE /api/schedule/google/disconnect - Revoke access
router.delete('/google/disconnect', auth, async (req, res) => {
  await User.findByIdAndUpdate(req.user._id, { $unset: { googleTokens: 1 } });
  res.json({ msg: 'Google Calendar disconnected' });
});

// DELETE /api/schedule/clear-all - Delete all blocks for user
router.delete('/clear-all', auth, async (req, res) => {
  try {
    const result = await StudyBlock.deleteMany({ userId: req.user._id });
    console.log(`Deleted ${result.deletedCount} blocks for user ${req.user._id}`);
    res.json({ msg: `Deleted ${result.deletedCount} study blocks` });
  } catch (err) {
    console.error('Clear all error:', err.message);
    res.status(500).json({ msg: 'Server error', error: err.message });
  }
});

// GET /api/schedule/export - Get all blocks for export
router.get('/export', auth, async (req, res) => {
  try {
    const blocks = await StudyBlock.find({
      userId: req.user._id,
      isBreak: false
    }).sort({ date: 1, startTime: 1 });
    res.json(blocks);
  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ msg: 'Server Error' });
  }
});

// GET /api/schedule/progress - Progress Rings
router.get('/progress', auth, async (req, res) => {
  try {
    const userId = req.user._id;
    const subjects = await StudyBlock.aggregate([
      { $match: { userId: new mongoose.Types.ObjectId(userId), isBreak: false } },
      {
        $group: {
          _id: '$subject',
          totalPlanned: { $sum: '$duration' },
          totalCompleted: { $sum: { $cond: ['$completed', '$duration', 0] } },
          totalActual: { $sum: '$actualDuration' }
        }
      }
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

// GET /api/schedule/readiness - Confidence Tracker
router.get('/readiness', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    const exams = await Exam.find({ userId: req.user._id });
    const scores = await Promise.all(exams.map(async exam => {
      const blocks = await StudyBlock.find({ userId: req.user._id, subject: exam.subject, isBreak: false });
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

// GET /api/schedule/affirmation - Daily Affirmations
router.get('/affirmation', auth, async (req, res) => {
  const quotes = [
    "Progress, not perfection.",
    "Small steps every day lead to big results.",
    "Deep work beats busy work.",
    "Consistency is your superpower.",
    "Focus on being productive instead of busy.",
    "One hour of deep focus > three hours of distraction.",
    "Your future self will thank you for today's effort.",
    "Discipline is choosing what you want most over what you want now.",
    "Study like your future depends on it.",
    "One hour of deep focus beats three hours of distraction.",
    "You didn't come this far to only come this far.",
    "The pain of studying is temporary. The pain of regret is forever.",
    "Consistency compounds. Show up daily.",
    "Exams don't test intelligence. They test preparation.",
    "Your future self will thank you for today's grind.",
    "Small steps every day lead to exam day victory.",
    "Deep work beats busy work. Lock in.",
    "Pressure makes diamonds. You're becoming one.",
    "Winners study when nobody is watching."
  ];
  const dayIndex = new Date().getDate() % quotes.length;
  res.json({ quote: quotes[dayIndex] });
});

// PATCH /api/schedule/user/confidence - Update confidence
router.patch('/user/confidence', auth, async (req, res) => {
  try {
    const { subject, level } = req.body;
    if (level < 1 || level > 10) return res.status(400).json({ msg: 'Level must be 1-10' });
    const user = await User.findById(req.user._id);
    if (!user.subjectConfidence) user.subjectConfidence = new Map();
    user.subjectConfidence.set(subject, level);
    await user.save();
    res.json({ subject, level });
  } catch (err) {
    res.status(500).json({ msg: 'Server Error' });
  }
});

// POST /api/schedule/log - Log actual study time
router.post('/log', auth, async (req, res) => {
  try {
    const { blockId, actualMinutes } = req.body;
    if (!mongoose.Types.ObjectId.isValid(blockId)) {
      return res.status(400).json({ msg: 'Invalid block ID' });
    }
    const block = await StudyBlock.findOneAndUpdate(
      { _id: blockId, userId: req.user._id },
      { actualDuration: actualMinutes, loggedAt: new Date(), completed: true },
      { new: true }
    );
    if (!block) return res.status(404).json({ msg: 'Block not found' });
    res.json(block);
  } catch (err) {
    res.status(500).json({ msg: 'Server Error' });
  }
});

// PATCH /api/schedule/:id/complete
router.patch('/:id/complete', auth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ msg: 'Invalid block ID' });
    }
    const block = await StudyBlock.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      { completed: true, missed: false },
      { new: true }
    );
    if (!block) return res.status(404).json({ msg: 'Block not found' });
    res.json(block);
  } catch (err) {
    console.error('Complete error:', err);
    res.status(500).json({ msg: 'Server Error' });
  }
});

// PATCH /api/schedule/:id/missed - TRUE Dynamic Rescheduling
router.patch('/:id/missed', auth, async (req, res) => {
  try {
    const userId = req.user._id;
    const blockId = req.params.id;

    if (!mongoose.Types.ObjectId.isValid(blockId)) {
      return res.status(400).json({ msg: 'Invalid block ID' });
    }

    const missedBlock = await StudyBlock.findOneAndUpdate(
      { _id: blockId, userId },
      { missed: true, completed: false },
      { new: true }
    );
    if (!missedBlock) return res.status(404).json({ msg: 'Block not found' });
    if (missedBlock.isBreak) {
      return res.status(400).json({
        success: false,
        msg: 'Breaks cannot be marked as missed'
      });
    }
    const exam = await Exam.findOne({ userId: userId, subject: missedBlock.subject });
    if (!exam) {
      return res.json({
        success: true,
        msg: 'Marked as missed. No exam found to reschedule.',
        missedBlock
      });
    }

    const futureBlocks = await StudyBlock.find({
      userId,
      subject: missedBlock.subject,
      date: { $gte: new Date() },
      isGenerated: true,
      completed: false,
      missed: false,
      isBreak: false
    });

    const missedMinutes = missedBlock.duration;
    const futureMinutes = futureBlocks.reduce((sum, b) => sum + b.duration, 0);
    const totalMinutesToReschedule = missedMinutes + futureMinutes;

    if (totalMinutesToReschedule === 0) {
      return res.json({ msg: 'No blocks to reschedule', missedBlock });
    }

    await StudyBlock.deleteMany({
      userId,
      subject: missedBlock.subject,
      date: { $gte: new Date() },
      isGenerated: true,
      completed: false
    });

    const config = {
      startDate: new Date(),
      startHour: 9,
      endHour: 18,
      studyBlock: exam.breakRatio?.study || 50,
      breakBlock: exam.breakRatio?.break || 10,
      breakRatio: exam.breakRatio
    };

    const rescheduleExam = {
      _id: exam._id,
      subject: exam.subject,
      examDate: exam.examDate,
      difficulty: exam.difficulty,
      currentKnowledge: exam.currentKnowledge,
      priority: exam.priority,
      availableHours: exam.availableHours,
      breakRatio: exam.breakRatio,
      color: exam.color,
      syllabusTopics: [{
        name: missedBlock.topic.replace(' (Rescheduled)', ''),
        hours: totalMinutesToReschedule / 60
      }]
    };

    const result = generateSchedule([rescheduleExam], config, []);

    if (result.conflicts?.length > 0) {
      await StudyBlock.findByIdAndUpdate(blockId, { missed: false });
      return res.status(400).json({
        msg: 'Cannot reschedule - insufficient time remaining before exam',
        conflicts: result.conflicts
      });
    }

    const newBlocks = result.schedule.flatMap(d => d.sessions.map(s => ({
      userId,
      examId: s.examId,
      subject: s.examName,
      topic: s.topicName,
      date: s.date,
      startTime: s.startTime,
      duration: s.duration,
      isGenerated: true,
      isBreak: s.isBreak || false,
      type: s.type || 'Study',
      intervalDay: s.intervalDay,
      priority: s.priority,
      color: s.color, // ← SAVE COLOR
      rescheduledFrom: missedBlock._id
    })));

    if (newBlocks.length > 0) {
      await StudyBlock.insertMany(newBlocks);
    }

    res.json({
      success: true,
      msg: `Rescheduled ${missedMinutes}min across ${newBlocks.length} new blocks`,
      missedBlock,
      newBlocksCreated: newBlocks.length,
      warnings: result.warnings
    });

  } catch (err) {
    console.error('Dynamic reschedule error:', err);
    res.status(500).json({ msg: 'Server Error', error: err.message });
  }
});

// PATCH /api/schedule/:id - Edit block for drag/drop + duration updates
router.patch('/:id', auth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ msg: 'Invalid block ID' });
    }

    // Coerce numeric fields and sanitize input
    const updateData = { ...req.body };
    if (updateData.duration !== undefined) updateData.duration = parseInt(updateData.duration);
    if (updateData.priority !== undefined) updateData.priority = parseInt(updateData.priority);
    if (updateData.actualDuration !== undefined) updateData.actualDuration = parseInt(updateData.actualDuration);
    
    // Prevent updating protected fields
    delete updateData._id;
    delete updateData.userId;
    delete updateData.isGenerated;
    delete updateData.createdAt;

    const block = await StudyBlock.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
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
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ msg: 'Invalid block ID' });
    }
    const block = await StudyBlock.findOneAndDelete({
      _id: req.params.id,
      userId: req.user._id
    });
    if (!block) return res.status(404).json({ msg: 'Block not found' });
    res.json({ msg: 'Block deleted' });
  } catch (err) {
    console.error('Delete block error:', err);
    res.status(500).json({ msg: 'Server Error' });
  }
});

module.exports = router;
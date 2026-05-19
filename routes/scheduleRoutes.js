const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const auth = require('../middleware/auth');
const { google } = require('googleapis');
const User = require('../models/User');
const Exam = require('../models/Exam');
const StudyBlock = require('../models/StudyBlock');
const { generateSchedule } = require('../utils/scheduler');

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

    let totalScheduled = 0;
    let totalCompleted = 0;
    const bySubject = {};

    blocks.forEach(block => {
      const hours = (block.duration || 0) / 60;
      const subject = block.subject || 'Other';

      totalScheduled += hours;
      if (block.completed) totalCompleted += hours;

      if (!bySubject[subject]) bySubject[subject] = 0;
      bySubject[subject] += hours;
    });

    Object.keys(bySubject).forEach(key => {
      bySubject[key] = Number(bySubject[key].toFixed(1));
    });

    res.json({
      totalScheduled: Number(totalScheduled.toFixed(1)),
      totalCompleted: Number(totalCompleted.toFixed(1)),
      bySubject
    });
  } catch (err) {
    console.error('Stats error:', err.message);
    res.status(500).json({ msg: 'Server error' });
  }
});

// GET /api/schedule/exams - Get all saved exams with progress
router.get('/exams', auth, async (req, res) => {
  try {
    const exams = await Exam.find({ userId: req.user._id }).sort({ examDate: 1 }).lean();

    for (let exam of exams) {
      const blocks = await StudyBlock.find({
        userId: req.user._id,
        subject: exam.subject,
        isBreak: false,
        isGenerated: true
      });

      const completedBlocks = blocks.filter(b => b.completed);
      const totalMinutes = blocks.reduce((sum, b) => sum + (b.duration || 0), 0);
      const completedMinutes = completedBlocks.reduce((sum, b) => sum + (b.duration || 0), 0);

      exam.totalScheduledHours = Number((totalMinutes / 60).toFixed(1));
      exam.completedHours = Number((completedMinutes / 60).toFixed(1));
      exam.progress = totalMinutes > 0? Math.round((completedMinutes / totalMinutes) * 100) : 0;
      exam.daysLeft = exam.examDate
       ? Math.ceil((new Date(exam.examDate) - new Date()) / (1000 * 60 * 60 * 24))
        : 0;
      exam.totalTopics = exam.syllabusTopics?.length || 0;
      exam.date = exam.examDate;
    }

    res.json(exams);
  } catch (err) {
    console.error('Exams fetch error:', err);
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
        priority: s.priority
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

// GET /api/schedule/export/pdf - Printable weekly timetable
router.get('/export/pdf', auth, async (req, res) => {
  try {
    const userId = req.user._id;
    const startDate = new Date();
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 7);

    const blocks = await StudyBlock.find({
      userId,
      date: { $gte: startDate, $lt: endDate },
      isBreak: false,
      missed: false
    }).sort({ date: 1, startTime: 1 });

    if (blocks.length === 0) {
      return res.status(400).json({ msg: 'No blocks to export this week. Generate a schedule first.' });
    }

    const palette = ['#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EF4444', '#06B6D4', '#EC4899', '#F97316', '#14B8A6', '#6366F1'];
    const colorMap = {};
    const uniqueSubjects = [...new Set(blocks.map(b => b.subject))];
    uniqueSubjects.forEach((subj, idx) => {
      colorMap[subj] = palette[idx % palette.length];
    });

    const hours = Array.from({ length: 14 }, (_, i) => i + 8);
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

    let tableRows = '';
    hours.forEach(hour => {
      tableRows += `<tr><td class="time-cell">${hour}:00</td>`;
      for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
        const cellBlocks = blocks.filter(b => {
          const bDate = new Date(b.date);
          const bDay = bDate.getDay() === 0? 6 : bDate.getDay() - 1;
          const bHour = parseInt(b.startTime.split(':')[0]);
          return bDay === dayIdx && bHour === hour;
        });

        let cellContent = '';
        cellBlocks.forEach(b => {
          const color = colorMap[b.subject];
          cellContent += `
            <div class="block" style="background:${color}">
              <strong>${b.subject}</strong><br/>
              ${b.topic}<br/>
              ${b.startTime} • ${b.duration}min
            </div>
          `;
        });
        tableRows += `<td class="day-cell">${cellContent}</td>`;
      }
      tableRows += '</tr>';
    });

    const weekStart = startDate.toLocaleDateString('en-GB');
    const weekEnd = new Date(endDate - 1).toLocaleDateString('en-GB');

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        @page { size: A4 landscape; margin: 10mm; }
        body { font-family: Arial, sans-serif; margin: 0; }
        h1 { text-align: center; margin: 0 0 10px 0; font-size: 24px; }
      .subtitle { text-align: center; margin-bottom: 15px; color: #666; }
        table { width: 100%; border-collapse: collapse; table-layout: fixed; }
        th { background: #1F2937; color: white; padding: 8px; font-size: 12px; }
        td { border: 1px solid #D1D5DB; vertical-align: top; padding: 2px; height: 45px; }
      .time-cell { width: 60px; background: #F3F4F6; font-weight: bold; text-align: center; font-size: 11px; }
      .day-cell { width: calc((100% - 60px) / 7); }
      .block { color: white; padding: 4px; margin: 1px 0; border-radius: 4px; font-size: 9px; line-height: 1.2; overflow: hidden; }
      .legend { margin-top: 10px; display: flex; gap: 15px; justify-content: center; flex-wrap: wrap; }
      .legend-item { display: flex; align-items: center; gap: 5px; font-size: 11px; }
      .legend-color { width: 15px; height: 15px; border-radius: 3px; }
      </style>
    </head>
    <body>
      <h1>Study Schedule</h1>
      <div class="subtitle">${weekStart} to ${weekEnd}</div>
      <table>
        <thead>
          <tr>
            <th>Time</th>
            ${days.map(d => `<th>${d}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${tableRows}
        </tbody>
      </table>
      <div class="legend">
        ${Object.entries(colorMap).map(([subj, color]) => `
          <div class="legend-item">
            <div class="legend-color" style="background:${color}"></div>
            <span>${subj}</span>
          </div>
        `).join('')}
      </div>
    </body>
    </html>
    `;

    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({
      format: 'A4',
      landscape: true,
      printBackground: true
    });
    await browser.close();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=study-schedule.pdf');
    res.send(pdf);

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
router.post('/google/sync', auth, async (req, res) => {
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
    if (missedBlock.isBreak) return res.status(400).json({ msg: 'Cannot miss a break' });

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

// PATCH /api/schedule/:id - Edit block for drag/drop
router.patch('/:id', auth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ msg: 'Invalid block ID' });
    }
    const block = await StudyBlock.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      { $set: req.body },
      { new: true }
    );
    if (!block) return res.status(404).json({ msg: 'Block not found' });
    res.json(block);
  } catch (err) {
    console.error('Update error:', err);
    res.status(500).json({ msg: 'Server Error' });
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
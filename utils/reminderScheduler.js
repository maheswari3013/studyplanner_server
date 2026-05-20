const cron = require('node-cron');
const webpush = require('web-push');
const User = require('../models/User');
const StudyBlock = require('../models/StudyBlock');
const Exam = require('../models/Exam');
const { generateSchedule } = require('./scheduler');

webpush.setVapidDetails(
  'mailto:dmaheswari3018@gmail.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// Helper: Convert IST "HH:MM" to UTC "HH:MM" for cron
const istToUtc = (timeStr) => {
  const [h, m] = timeStr.split(':').map(Number);
  let utcH = h - 5;
  let utcM = m - 30;
  if (utcM < 0) { utcM += 60; utcH -= 1; }
  if (utcH < 0) utcH += 24;
  return `${String(utcH).padStart(2,'0')}:${String(utcM).padStart(2,'0')}`;
};

// Runs every minute to check for blocks starting now + overdue blocks
cron.schedule('* * * * *', async () => {
  try {
    const now = new Date();
    const utcTime = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
    const today = now.toISOString().split('T')[0];

    // 1. Send reminders for blocks starting now
    const startingBlocks = await StudyBlock.find({
      startTime: utcTime,
      date: today,
      status: 'scheduled',
      isBreak: false,
      type: { $in: ['Study', 'Review'] }
    }).populate('user'); // FIX: was userId

    for (const block of startingBlocks) {
      const user = block.user; // FIX: was userId
      if (!user?.subscriptions?.length) continue;

      const payload = JSON.stringify({
        title: `Time to ${block.type}: ${block.subject}`,
        body: `Start your ${block.topic} at ${block.time} - ${block.duration} min session`,
        icon: '/icon-192.png',
        data: { url: '/agenda' }
      });

      const promises = user.subscriptions.map(sub =>
        webpush.sendNotification(sub, payload).catch(err => {
          if (err.statusCode === 410) {
            User.findByIdAndUpdate(user._id, {
              $pull: { subscriptions: { endpoint: sub.endpoint } }
            }).exec();
          }
          console.error('Push error:', err.message);
        })
      );

      await Promise.all(promises);
      console.log(`Reminder sent: ${block.subject} - ${block.topic} at ${block.time} IST`);
    }

    // 2. Find and reschedule overdue blocks
    const overdueBlocks = await StudyBlock.find({
      status: 'scheduled',
      date: { $lte: today },
      isBreak: false
    });

    // Filter blocks where end time has passed
    const actuallyOverdue = overdueBlocks.filter(block => {
      const [h, m] = block.time.split(':').map(Number);
      const blockEndMinutes = h * 60 + m + block.duration;
      const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes() + 330; // Convert UTC to IST mins
      return block.date < today || (block.date === today && blockEndMinutes < (nowMinutes % 1440));
    });

    if (actuallyOverdue.length > 0) {
      console.log(`[CRON] Found ${actuallyOverdue.length} overdue blocks to reschedule`);

      for (const block of actuallyOverdue) {
        // Mark as overdue
        block.status = 'overdue';
        await block.save();
        console.log(`[CRON] OVERDUE: ${block.subject} ${block.time}`);

        // Add hours back to topic
        const exam = await Exam.findOne({ user: block.user, subject: block.subject }); // FIX: user not userId
        if (exam) {
          const topic = exam.syllabusTopics.find(t => t.name === block.topic);
          if (topic) {
            topic.missedHours = (topic.missedHours || 0) + (block.duration / 60);
            await exam.save();
            console.log(`[CRON] Added ${(block.duration / 60).toFixed(1)}h back to ${block.topic}`);
          }
        }
      }

      // Regenerate for all affected users
      const userIds = [...new Set(actuallyOverdue.map(b => b.user.toString()))]; // FIX: user not userId
      for (const userId of userIds) {
        const exams = await Exam.find({ user: userId }); // FIX: user not userId
        const allBlocks = await StudyBlock.find({ user: userId }); // FIX: user not userId
        const config = {
          startDate: new Date(),
          startHour: 15, // Start from now
          endHour: 23,
          studyBlock: 25,
          breakBlock: 5
        };
        const result = generateSchedule(exams, config, allBlocks);
        const newBlocks = result.schedule.flatMap(d => d.sessions.map(s => ({
          user: userId, subject: s.examName, topic: s.topicName, date: s.date,
          time: s.startTime, startTime: istToUtc(s.startTime), duration: s.duration,
          isGenerated: true, isBreak: s.isBreak || false, type: s.type || 'Study',
          color: s.color, status: 'scheduled', priority: s.priority
        })));
        if (newBlocks.length > 0) {
          await StudyBlock.insertMany(newBlocks);
          console.log(`[CRON] User ${userId}: Generated ${newBlocks.length} replacement blocks`);
        }
      }
    }

  } catch (err) {
    console.error('[CRON] Error:', err.message);
  }
});

// Mark yesterday's unfinished blocks as missed at 12:01am UTC
cron.schedule('1 0 * * *', async () => {
  try {
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    const result = await StudyBlock.updateMany(
      { date: yesterday, status: 'scheduled', isBreak: false },
      { status: 'missed' }
    );
    console.log(`Marked ${result.modifiedCount} blocks as missed from ${yesterday}`);
  } catch (err) {
    console.error('Cleanup cron error:', err);
  }
});

console.log('Reminder scheduler started');
module.exports = cron;
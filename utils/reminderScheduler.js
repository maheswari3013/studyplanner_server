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
    }).populate('user');

    for (const block of startingBlocks) {
      const user = block.user;
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
      endTime: { $lt: now },
      isBreak: false
    });

    if (overdueBlocks.length > 0) {
      console.log(`[CRON] Found ${overdueBlocks.length} overdue blocks to reschedule`);

      for (const block of overdueBlocks) {
        // Mark as overdue
        block.status = 'overdue';
        await block.save();

        // Add hours back to topic
        const exam = await Exam.findOne({ user: block.user, subject: block.subject });
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
      const userIds = [...new Set(overdueBlocks.map(b => b.user.toString()))];
      for (const userId of userIds) {
        const exams = await Exam.find({ user: userId });
        const allBlocks = await StudyBlock.find({ user: userId });
        const config = {
          startDate: new Date(),
          startHour: 9,
          endHour: 23,
          studyBlock: 25,
          breakBlock: 5
        };
        const result = generateSchedule(exams, config, allBlocks);
        const newBlocks = result.schedule.flatMap(d => d.sessions.map(s => ({
          user: userId, subject: s.examName, topic: s.topicName, date: s.date,
          time: s.startTime, startTime: s.startTime, duration: s.duration,
          isGenerated: true, isBreak: s.isBreak || false, type: s.type || 'Study',
          color: s.color, status: 'scheduled'
        })));
        if (newBlocks.length > 0) {
          await StudyBlock.insertMany(newBlocks);
          console.log(`[CRON] User ${userId}: Generated ${newBlocks.length} replacement blocks`);
        }
      }
    }

  } catch (err) {
    console.error('Cron error:', err);
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
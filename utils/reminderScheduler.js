const cron = require('node-cron');
const webpush = require('web-push');
const User = require('../models/User');
const StudyBlock = require('../models/StudyBlock');

webpush.setVapidDetails(
  'mailto:dmaheswari3018@gmail.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// Runs every minute to check for blocks starting now
cron.schedule('* * * * *', async () => {
  try {
    const now = new Date();
    const utcTime = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
    const today = now.toISOString().split('T')[0]; // "2026-05-20" UTC date

    // FIX: Find blocks using UTC startTime
    const blocks = await StudyBlock.find({
      startTime: utcTime, // This is UTC "04:20" 
      date: today,
      completed: false,
      missed: false,
      isBreak: false,
      type: { $in: ['Study', 'Review'] }
    }).populate('userId');

    for (const block of blocks) {
      const user = block.userId;
      if (!user?.subscriptions?.length) continue;

      // FIX: Use block.time for IST display in notification
      const payload = JSON.stringify({
        title: `Time to ${block.type}: ${block.subject}`,
        body: `Start your ${block.topic} at ${block.time} - ${block.duration} min session`,
        icon: '/icon-192x192.png',
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
  } catch (err) {
    console.error('Reminder cron error:', err);
  }
});

// Mark yesterday's unfinished blocks as missed at 12:01am UTC
cron.schedule('1 0 * * *', async () => {
  try {
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    const result = await StudyBlock.updateMany(
      { date: yesterday, completed: false, missed: false, isBreak: false },
      { missed: true }
    );
    console.log(`Marked ${result.modifiedCount} blocks as missed from ${yesterday}`);
  } catch (err) {
    console.error('Cleanup cron error:', err);
  }
});

console.log('Reminder scheduler started');
module.exports = cron;
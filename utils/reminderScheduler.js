const cron = require('node-cron');
const webpush = require('web-push');
const User = require('../models/User');
const StudyBlock = require('../models/StudyBlock');

webpush.setVapidDetails(
  'mailto:dmaheswari3018@gmail.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// Runs every minute to send push notifications for blocks starting now
cron.schedule('* * * * *', async () => {
  try {
    const now = new Date();
    const utcTime = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
    const today = now.toISOString().split('T')[0];

    const startingBlocks = await StudyBlock.find({
      startTime: utcTime,
      date: today,
      completed: false,
      missed: false,
      isBreak: false,
      type: { $in: ['Study', 'Review'] }
    }).populate('user');

    for (const block of startingBlocks) {
      const user = block.user;
      if (!user?.subscriptions?.length) continue;

      const payload = JSON.stringify({
        title: `Time to ${block.type}: ${block.subject}`,
        body: `Start ${block.topic} at ${block.time} - ${block.duration} min`,
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
      console.log(`Push sent: ${block.subject} - ${block.topic} at ${block.time} IST`);
    }
  } catch (err) {
    console.error('[REMINDER] Error:', err.message);
  }
});

console.log('Reminder scheduler started');
module.exports = cron;
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
    const utcHours = String(now.getUTCHours()).padStart(2, '0');
    const utcMinutes = String(now.getUTCMinutes()).padStart(2, '0');
    const utcTime = `${utcHours}:${utcMinutes}`;
    const today = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

    // Find blocks starting right now
    const startingBlocks = await StudyBlock.find({
      startTime: utcTime,
      date: today,
      completed: false,
      missed: false,
      isBreak: false,
      type: { $in: ['Study', 'Review'] }
    }).populate('user');

    if (startingBlocks.length === 0) return;

    for (const block of startingBlocks) {
      const user = block.user;
      if (!user?.subscriptions?.length) continue;

      const payload = JSON.stringify({
        title: `Time to ${block.type}: ${block.subject}`,
        body: `${block.topic} - ${block.duration} min session starting now`,
        icon: '/icon-192.png',
        badge: '/badge-72.png',
        data: { url: '/agenda' }
      });

      const results = await Promise.allSettled(
        user.subscriptions.map(sub =>
          webpush.sendNotification(sub, payload)
        )
      );

      // Clean up expired subscriptions
      const expiredEndpoints = [];
      results.forEach((result, idx) => {
        if (result.status === 'rejected' && result.reason.statusCode === 410) {
          expiredEndpoints.push(user.subscriptions[idx].endpoint);
        }
      });

      if (expiredEndpoints.length > 0) {
        await User.findByIdAndUpdate(user._id, {
          $pull: { subscriptions: { endpoint: { $in: expiredEndpoints } } }
        });
      }

      console.log(`Push sent: ${block.subject} - ${block.topic} at ${block.time} IST`);
    }
  } catch (err) {
    console.error('[REMINDER] Error:', err.message);
  }
});

// Mark yesterday's unfinished blocks as missed at 12:01am UTC
cron.schedule('1 0 * * *', async () => {
  try {
    const yesterday = new Date(Date.now() - 86400000);
    const yesterdayStr = yesterday.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    
    const result = await StudyBlock.updateMany(
      { 
        date: yesterdayStr, 
        completed: false, 
        missed: false, 
        isBreak: false 
      },
      { missed: true }
    );
    console.log(`[CLEANUP] Marked ${result.modifiedCount} blocks as missed from ${yesterdayStr}`);
  } catch (err) {
    console.error('[CLEANUP] Error:', err.message);
  }
});

console.log('Reminder scheduler started');
module.exports = cron;
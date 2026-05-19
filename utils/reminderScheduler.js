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
    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    // Find StudyBlocks starting right now
    const blocks = await StudyBlock.find({
      startTime: currentTime,
      date: { $gte: todayStart, $lte: todayEnd },
      completed: false,
      missed: false,
      isBreak: false,
      type: { $in: ['Study', 'Review'] } // Don't notify for breaks
    }).populate('userId');

    for (const block of blocks) {
      const user = block.userId;
      if (!user?.subscriptions?.length) continue;

      const payload = JSON.stringify({
        title: `Time to ${block.type}: ${block.subject}`,
        body: `It's ${currentTime} - start your ${block.topic}. ${block.duration} min session`,
        icon: '/icon-192x192.png',
        data: { url: '/dashboard' }
      });

      const promises = user.subscriptions.map(sub =>
        webpush.sendNotification(sub, payload).catch(err => {
          if (err.statusCode === 410) {
            // Subscription expired, remove it
            User.findByIdAndUpdate(user._id, {
              $pull: { subscriptions: { endpoint: sub.endpoint } }
            }).exec();
          }
          console.error('Push error:', err.message);
        })
      );
      
      await Promise.all(promises);
      console.log(`Reminder sent: ${block.subject} - ${block.topic} to ${user.email}`);
    }
  } catch (err) {
    console.error('Reminder cron error:', err);
  }
});

console.log('Reminder scheduler started');
module.exports = cron;
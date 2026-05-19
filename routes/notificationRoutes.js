const router = require('express').Router();
const auth = require('../middleware/auth');
const webpush = require('web-push');
const cron = require('node-cron');
const User = require('../models/User');
const StudyBlock = require('../models/StudyBlock');

webpush.setVapidDetails(
  'mailto:dmaheswari3018@gmail.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// GET /api/notifications/vapid-public-key - ADD THIS
router.get('/vapid-public-key', auth, (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// POST /api/notifications/subscribe
router.post('/subscribe', auth, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.user._id, {
      $addToSet: { subscriptions: req.body }
    });
    res.json({ msg: 'Subscribed to push notifications' });
  } catch (err) {
    console.error('Subscribe error:', err);
    res.status(500).json({ msg: 'Server error' });
  }
});

// DELETE /api/notifications/unsubscribe
router.delete('/unsubscribe', auth, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.user._id, {
      $pull: { subscriptions: { endpoint: req.body.endpoint } }
    });
    res.json({ msg: 'Unsubscribed' });
  } catch (err) {
    res.status(500).json({ msg: 'Server error' });
  }
});

// CRON JOB - Sends reminders every minute
cron.schedule('* * * * *', async () => {
  try {
    const now = new Date();
    const currentHour = String(now.getHours()).padStart(2, '0');
    const currentMinute = String(now.getMinutes()).padStart(2, '0');
    const currentTime = `${currentHour}:${currentMinute}`;
    
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    // Find blocks starting right now
    const blocks = await StudyBlock.find({
      startTime: currentTime,
      date: { $gte: todayStart, $lte: todayEnd },
      completed: false,
      missed: false,
      isBreak: false
    }).populate('userId');

    for (const block of blocks) {
      const user = block.userId;
      if (!user || !user.subscriptions || user.subscriptions.length === 0) continue;

      const payload = JSON.stringify({
        title: `Time to study: ${block.subject}`,
        body: `It's ${currentTime} - start your ${block.topic} session. ${block.duration} min`,
        icon: '/icon-192.png',
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
      console.log(`Sent reminder for ${block.subject} to ${user.email}`);
    }
  } catch (err) {
    console.error('Cron error:', err);
  }
});

// POST /api/notifications/send - Manual test endpoint
router.post('/send', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user.subscriptions || user.subscriptions.length === 0) {
      return res.status(400).json({ msg: 'No subscriptions found. Enable notifications first.' });
    }

    const payload = JSON.stringify({
      title: req.body.title || 'Test Notification',
      body: req.body.body || 'It works!',
      icon: '/icon-192.png',
      data: { url: '/dashboard' }
    });

    const promises = user.subscriptions.map(sub =>
      webpush.sendNotification(sub, payload).catch(err => console.log(err))
    );
    
    await Promise.all(promises);
    res.json({ msg: 'Push sent' });
  } catch (err) {
    res.status(500).json({ msg: 'Server error' });
  }
});


module.exports = router;
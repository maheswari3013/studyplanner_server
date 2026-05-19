const router = require('express').Router();
const auth = require('../middleware/auth');
const webpush = require('web-push');
const cron = require('node-cron');
const User = require('../models/User');
const StudyBlock = require('../models/StudyBlock');

webpush.setVapidDetails(
  'mailto:admin@studysync.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// POST /api/notifications/subscribe
router.post('/subscribe', auth, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.user._id, {
      pushSubscription: req.body
    });
    res.json({ msg: 'Subscribed to push notifications' });
  } catch (err) {
    res.status(500).json({ msg: 'Server error' });
  }
});

// DELETE /api/notifications/unsubscribe
router.delete('/unsubscribe', auth, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.user._id, {
      $unset: { pushSubscription: 1 }
    });
    res.json({ msg: 'Unsubscribed' });
  } catch (err) {
    res.status(500).json({ msg: 'Server error' });
  }
});

// GET /api/notifications/vapid-public-key
router.get('/vapid-public-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// Cron: 8am daily reminder
cron.schedule('0 8 * * *', async () => {
  console.log('Running daily study reminders...');
  const users = await User.find({ pushSubscription: { $exists: true } });

  for (const user of users) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const blocks = await StudyBlock.find({
      userId: user._id,
      date: { $gte: today, $lt: tomorrow },
      completed: false,
      isBreak: false
    }).sort({ startTime: 1 });

    if (blocks.length > 0) {
      const payload = JSON.stringify({
        title: 'StudySync Reminder',
        body: `You have ${blocks.length} study blocks today. First: ${blocks[0].subject} at ${blocks[0].startTime}`,
        icon: '/icon-192.png',
        data: { url: '/agenda' }
      });

      webpush.sendNotification(user.pushSubscription, payload).catch(err => {
        console.error('Push error for user', user._id, err.message);
      });
    }
  }
});

module.exports = router;
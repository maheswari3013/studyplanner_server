const router = require('express').Router();
const auth = require('../middleware/auth');
const webpush = require('web-push');
const cron = require('node-cron');
const User = require('../models/User');
const StudyBlock = require('../models/StudyBlock');

webpush.setVapidDetails(
  'mailto:dmaheswari3018@gmail.com', // Must match Render VAPID_MAILTO
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// POST /api/notifications/subscribe
router.post('/subscribe', auth, async (req, res) => {
  try {
    // Use $addToSet to support multiple devices
    await User.findByIdAndUpdate(req.user._id, {
      $addToSet: { subscriptions: req.body }
    });
    res.json({ msg: 'Subscribed to push notifications' });
  } catch (err) {
    console.error(err);
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

// POST /api/notifications/send - Manual test endpoint
router.post('/send', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    const payload = JSON.stringify({
      title: req.body.title || 'Test Notification',
      body: req.body.body || 'It works!'
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
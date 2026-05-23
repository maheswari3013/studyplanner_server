const router = require('express').Router();
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const authMiddleware = require('../middleware/auth');
const User = require('../models/User');

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const clientUrl = process.env.CLIENT_URL || process.env.FRONTEND_URL || 'https://studyplanner-client.vercel.app';
const googleCallbackUrl = process.env.GOOGLE_CALLBACK_URL || process.env.GOOGLE_REDIRECT_URI;
const googleCalendarCallbackUrl = process.env.GOOGLE_CALENDAR_CALLBACK || process.env.GOOGLE_CALENDAR_CALLBACK_URL;

const escapeScriptValue = (value = '') => String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

router.get('/google', (req, res) => {
  res.redirect('/api/auth/google/login');
});

router.get('/google/login', (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: googleCallbackUrl,
    response_type: 'code',
    scope: 'profile email',
    access_type: 'offline',
    prompt: 'consent'
  });

  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

router.get('/google/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).send('Missing code');

    const { tokens } = await client.getToken({ code, redirect_uri: googleCallbackUrl });
    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: process.env.GOOGLE_CLIENT_ID
    });
    const { sub: googleId, email, name, picture } = ticket.getPayload();

    let user = await User.findOne({ $or: [{ googleId }, { email }] });
    if (!user) {
      user = await User.create({
        googleId,
        email,
        name,
        username: name || email.split('@')[0],
        avatar: picture,
        googleAccessToken: tokens.access_token,
        googleRefreshToken: tokens.refresh_token,
        googleTokenExpiry: tokens.expiry_date
      });
    } else {
      user.googleId = user.googleId || googleId;
      user.name = user.name || name;
      user.username = user.username || name || email.split('@')[0];
      user.avatar = user.avatar || picture;
      user.googleAccessToken = tokens.access_token;
      if (tokens.refresh_token) user.googleRefreshToken = tokens.refresh_token;
      user.googleTokenExpiry = tokens.expiry_date;
      await user.save();
    }

    const token = jwt.sign(
      { id: user._id, _id: user._id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '5d' }
    );

    res.send(`<script>window.opener.postMessage({type:'google-login-success',token:'${escapeScriptValue(token)}'},'${clientUrl}');window.close();</script>`);
  } catch (err) {
    console.error('Google login callback error:', err.response?.data || err.message);
    res.status(500).send(`<script>window.opener.postMessage({type:'google-login-error',error:'${escapeScriptValue(err.message)}'},'${clientUrl}');window.close();</script>`);
  }
});

router.get('/google/calendar', authMiddleware, (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: googleCalendarCallbackUrl,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/calendar',
    access_type: 'offline',
    prompt: 'consent',
    state: jwt.sign({ id: req.user._id }, process.env.JWT_SECRET, { expiresIn: '10m' })
  });

  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

router.get('/google/calendar/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code) return res.status(400).send('Missing code');

    let userId = req.user?._id;
    if (!userId && state) {
      const decoded = jwt.verify(state, process.env.JWT_SECRET);
      userId = decoded.id || decoded._id;
    }
    if (!userId) return res.status(400).send('Missing state');

    const { tokens } = await client.getToken({
      code,
      redirect_uri: process.env.GOOGLE_CALENDAR_CALLBACK || googleCalendarCallbackUrl
    });

    const update = {
      googleAccessToken: tokens.access_token,
      googleTokenExpiry: tokens.expiry_date,
      googleTokens: tokens
    };
    if (tokens.refresh_token) update.googleRefreshToken = tokens.refresh_token;

    await User.findByIdAndUpdate(userId, update);

    res.send(`<script>window.opener.postMessage({type:'google-calendar-success'},'${clientUrl}');window.close();</script>`);
  } catch (err) {
    console.error('Calendar callback error:', err.response?.data || err.message);
    res.status(500).send('Calendar connection failed');
  }
});

router.get('/user/me', authMiddleware, async (req, res) => {
  const user = await User.findById(req.user._id).select('-password');
  if (!user) return res.status(404).json({ msg: 'User not found' });

  res.json({
    _id: user._id,
    email: user.email,
    name: user.name || user.username,
    googleId: user.googleId,
    hasCalendar: !!user.googleRefreshToken
  });
});

module.exports = router;

const router = require('express').Router();
const { OAuth2Client } = require('google-auth-library');
const { google } = require('googleapis');
const jwt = require('jsonwebtoken');
const authMiddleware = require('../middleware/auth');
const User = require('../models/User');

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const clientUrl = process.env.CLIENT_URL || process.env.FRONTEND_URL || 'https://studyplanner-client.vercel.app';
const googleCallbackUrl = process.env.GOOGLE_CALLBACK_URL || process.env.GOOGLE_REDIRECT_URI;
const googleCalendarCallbackUrl = process.env.GOOGLE_CALENDAR_CALLBACK || process.env.GOOGLE_CALENDAR_CALLBACK_URL;

const getGoogleCallbackUrl = (req) => {
  const host = req.get('host');
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  if (host.includes('localhost') || host.includes('127.0.0.1')) {
    return `${protocol}://${host}/api/auth/google/callback`;
  }
  return process.env.GOOGLE_REDIRECT_URI || `${protocol}://${host}/api/auth/google/callback`;
};

const getGoogleCalendarCallbackUrl = (req) => {
  const host = req.get('host');
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  if (host.includes('localhost') || host.includes('127.0.0.1')) {
    return `${protocol}://${host}/api/auth/google/calendar/callback`;
  }
  return process.env.GOOGLE_CALENDAR_CALLBACK || process.env.GOOGLE_CALENDAR_CALLBACK_URL || `${protocol}://${host}/api/auth/google/calendar/callback`;
};

const escapeScriptValue = (value = '') => String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

router.get('/google', (req, res) => {
  const origin = req.query.origin ? `?origin=${encodeURIComponent(req.query.origin)}` : '';
  res.redirect(`/api/auth/google/login${origin}`);
});

router.get('/google/login', (req, res) => {
  const origin = req.query.origin || clientUrl;
  const callbackUrl = getGoogleCallbackUrl(req);
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: callbackUrl,
    response_type: 'code',
    scope: 'profile email',
    access_type: 'offline',
    prompt: 'consent',
    state: origin
  });

  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

router.get('/google/callback', async (req, res) => {
  const { code, state } = req.query;
  const targetOrigin = state || clientUrl;

  try {
    if (!code) return res.status(400).send('Missing code');

    const callbackUrl = getGoogleCallbackUrl(req);
    const { tokens } = await client.getToken({ code, redirect_uri: callbackUrl });
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

    res.send(`<script>window.opener.postMessage({type:'google-login-success',token:'${escapeScriptValue(token)}'},'${targetOrigin}');window.close();</script>`);
  } catch (err) {
    console.error('Google login callback error:', err.response?.data || err.message);
    res.status(500).send(`<script>window.opener.postMessage({type:'google-login-error',error:'${escapeScriptValue(err.message)}'},'${targetOrigin}');window.close();</script>`);
  }
});

router.get('/google/calendar', authMiddleware, (req, res) => {
  const origin = req.query.origin || clientUrl;
  const callbackUrl = getGoogleCalendarCallbackUrl(req);
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: callbackUrl,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/calendar',
    access_type: 'offline',
    prompt: 'consent',
    state: jwt.sign({ id: req.user._id, origin }, process.env.JWT_SECRET, { expiresIn: '10m' })
  });

  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

router.get('/google/calendar/callback', async (req, res) => {
  let targetOrigin = clientUrl;
  try {
    const { code, state } = req.query;
    if (!code) return res.status(400).send('Missing code');

    let userId = req.user?._id;
    if (state) {
      try {
        const decoded = jwt.verify(state, process.env.JWT_SECRET);
        userId = userId || decoded.id || decoded._id;
        if (decoded.origin) {
          targetOrigin = decoded.origin;
        }
      } catch (jwtErr) {
        console.error('JWT verify state error:', jwtErr.message);
      }
    }
    if (!userId) return res.status(400).send('Missing state');

    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      getGoogleCalendarCallbackUrl(req)
    );
    const { tokens } = await oauth2Client.getToken(code);

    const update = {
      googleAccessToken: tokens.access_token,
      googleTokenExpiry: tokens.expiry_date,
      googleTokens: tokens
    };
    if (tokens.refresh_token) update.googleRefreshToken = tokens.refresh_token;

    await User.findByIdAndUpdate(userId, update);

    res.send(`<script>window.opener.postMessage({type:'google-calendar-success'},'${targetOrigin}');window.close();</script>`);
  } catch (err) {
    console.error('Calendar callback error:', err.response?.data || err.message);
    res.status(500).send(`<script>window.opener.postMessage({type:'google-calendar-error',error:'${escapeScriptValue(err.message)}'},'${targetOrigin}');window.close();</script>`);
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

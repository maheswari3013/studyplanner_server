const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const User = require('../models/User');

const API_BASE_URL = process.env.API_BASE_URL || 'https://studyplanner-api-awmh.onrender.com';

const buildCallbackUrl = (path) => {
  const explicit = process.env[path.envName] || (path.fallbackEnvName && process.env[path.fallbackEnvName]);
  if (explicit) return explicit;
  return `${API_BASE_URL}${path.route}`;
};

const googleConfig = {
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET
};

passport.use('google-login', new GoogleStrategy({
  ...googleConfig,
  callbackURL: buildCallbackUrl({ envName: 'GOOGLE_LOGIN_CALLBACK_URL', route: '/api/auth/google/login/callback' })
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const email = profile.emails?.[0]?.value;
    if (!email) return done(new Error('Google account did not return an email'));

    const update = {
      googleId: profile.id,
      username: profile.displayName || email.split('@')[0],
      email,
      avatar: profile.photos?.[0]?.value,
      googleAccessToken: accessToken
    };
    if (refreshToken) update.googleRefreshToken = refreshToken;

    const user = await User.findOneAndUpdate(
      { $or: [{ googleId: profile.id }, { email }] },
      { $set: update },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    return done(null, user);
  } catch (err) {
    return done(err);
  }
}));

passport.use('google-calendar', new GoogleStrategy({
  ...googleConfig,
  callbackURL: buildCallbackUrl({
    envName: 'GOOGLE_CALENDAR_CALLBACK',
    fallbackEnvName: 'GOOGLE_CALENDAR_CALLBACK_URL',
    route: '/api/auth/google/calendar/callback'
  })
}, (accessToken, refreshToken, params, profile, done) => {
  return done(null, {
    profile,
    tokens: {
      access_token: accessToken,
      refresh_token: refreshToken,
      expiry_date: params.expires_in ? Date.now() + params.expires_in * 1000 : undefined,
      scope: params.scope,
      token_type: params.token_type || 'Bearer'
    }
  });
}));

module.exports = passport;

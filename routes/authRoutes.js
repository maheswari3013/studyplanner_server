const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const passport = require('../config/passport');
const User = require('../models/User');
const OTP = require('../models/OTP');
const auth = require('../middleware/auth');
const { sendOTPEmail } = require('../utils/sendEmail');

const frontendOrigin = 'https://studyplanner-client.vercel.app';
const signToken = (user) => jwt.sign(
  { id: user._id, email: user.email, role: user.role },
  process.env.JWT_SECRET,
  { expiresIn: '5d' }
);
const escapeScriptValue = (value = '') => String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const sendOAuthSuccess = (res, token) => {
  res.send(`<script>window.opener.postMessage({type:'success',token:'${escapeScriptValue(token)}'},'${frontendOrigin}');window.close()</script>`);
};
const sendOAuthError = (res, error, status = 500) => {
  res.status(status).send(`<script>window.opener.postMessage({type:'error',error:'${escapeScriptValue(error)}'},'${frontendOrigin}');window.close()</script>`);
};

const validatePassword = (password) => {
  const regex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{6,}$/;
  return regex.test(password);
};

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { username, email, password } = req.body;

  try {
    if (!username || !email || !password) {
      return res.status(400).json({ msg: 'Please provide all fields' });
    }

    if (!validatePassword(password)) {
      return res.status(400).json({ msg: 'Password must be 6+ chars with upper, lower, number & symbol' });
    }

    let user = await User.findOne({ email });
    if (user && user.password) return res.status(400).json({ msg: 'User already exists' });

    await OTP.deleteMany({ email, type: 'register' });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    await OTP.create({ username, email, password: hashedPassword, otp, type: 'register' });
    console.log('OTP saved to DB:', { email, otp, type: 'register' }); // ADD THIS LINE

    try {
      await sendOTPEmail(email, otp, 'register');
      console.log('SendGrid accepted email for:', email); // ADD THIS TOO
      res.json({ success: true, msg: 'OTP sent to your email' });
    } catch (emailErr) {
      console.error('SendOTP Error:', emailErr.message);
      res.json({ 
        success: true, 
        msg: 'Email service unavailable. Use this OTP:', 
        otp: otp,
        devMode: true 
      });
    }

  } catch (err) {
    console.error('Register error:', err.message);
    res.status(500).json({ msg: 'Server error during registration' });
  }
});

// POST /api/auth/verify-register
router.post('/verify-register', async (req, res) => {
  const { email, otp } = req.body;

  try {
    const otpDoc = await OTP.findOne({ email, otp, type: 'register' });
    if (!otpDoc) return res.status(400).json({ msg: 'Invalid or expired OTP' });

    let user = await User.findOne({ email });
    if (user) {
      user.password = otpDoc.password;
      user.username = otpDoc.username || user.username;
      await user.save();
    } else {
      user = new User({
        username: otpDoc.username,
        email: otpDoc.email,
        password: otpDoc.password
      });
      await user.save();
    }
    await OTP.deleteMany({ email, type: 'register' });

    const payload = { id: user._id, email: user.email, role: user.role };
    jwt.sign(
      payload,
      process.env.JWT_SECRET,
      { expiresIn: '5d' },
      (err, token) => {
        if (err) throw err;
        const userData = {
          _id: user._id,
          username: user.username,
          email: user.email,
          theme: user.theme,
          hasPassword: !!user.password
        };
        res.json({ token, user: userData });
      }
    );
  } catch (err) {
    console.error('Verify register error:', err.message);
    res.status(500).json({ msg: 'Server error' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ msg: 'Invalid credentials' });
    if (!user.password) return res.status(400).json({ msg: 'Use Google login for this account' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ msg: 'Invalid credentials' });

    const payload = { id: user._id, email: user.email, role: user.role };
    jwt.sign(
      payload,
      process.env.JWT_SECRET,
      { expiresIn: '5d' },
      (err, token) => {
        if (err) throw err;
        const userData = {
          _id: user._id,
          username: user.username,
          email: user.email,
          theme: user.theme,
          role: user.role,
          hasPassword: !!user.password
        };
        res.json({ token, user: userData });
      }
    );
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).send('Server error');
  }
});

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;

  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ msg: 'No account found with this email' });

    await OTP.deleteMany({ email, type: 'reset' });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    await OTP.create({ email, otp, type: 'reset' });

    try {
      await sendOTPEmail(email, otp, 'reset');
      res.json({ success: true, msg: 'Reset OTP sent to your email' });
    } catch (emailErr) {
      console.error('SendOTP Error:', emailErr.message);
      res.json({ 
        success: true, 
        msg: 'Email service unavailable. Use this OTP:', 
        otp: otp,
        devMode: true 
      });
    }

  } catch (err) {
    console.error('Forgot password error:', err.message);
    res.status(500).json({ msg: 'Server error' });
  }
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
  const { email, otp, newPassword } = req.body;

  try {
    if (!validatePassword(newPassword)) {
      return res.status(400).json({ msg: 'Password must be 6+ chars with upper, lower, number & symbol' });
    }

    const otpDoc = await OTP.findOne({ email, otp, type: 'reset' });
    if (!otpDoc) return res.status(400).json({ msg: 'Invalid or expired OTP' });

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    await User.findOneAndUpdate({ email }, { password: hashedPassword });
    await OTP.deleteMany({ email, type: 'reset' });

    res.json({ success: true, msg: 'Password reset successful' });
  } catch (err) {
    console.error('Reset password error:', err.message);
    res.status(500).json({ msg: 'Server error' });
  }
});

// GET /api/auth/user
router.get('/user', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ msg: 'User not found' });
    const userObj = user.toObject();
    userObj.hasPassword = !!user.password;
    delete userObj.password;
    res.json(userObj);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

router.get('/google/login', passport.authenticate('google-login', {
  scope: ['profile', 'email'],
  session: false
}));

router.get('/google/login/callback', (req, res, next) => {
  passport.authenticate('google-login', { session: false }, (err, user) => {
    if (err || !user) return sendOAuthError(res, err?.message || 'Google login failed', 401);
    return sendOAuthSuccess(res, signToken(user));
  })(req, res, next);
});

router.get('/google/calendar', auth, (req, res, next) => {
  const state = jwt.sign(
    { id: req.user.id, purpose: 'google-calendar' },
    process.env.JWT_SECRET,
    { expiresIn: '10m' }
  );

  passport.authenticate('google-calendar', {
    scope: ['https://www.googleapis.com/auth/calendar.events'],
    accessType: 'offline',
    prompt: 'consent',
    state,
    session: false
  })(req, res, next);
});

router.get('/google/calendar/callback', (req, res, next) => {
  passport.authenticate('google-calendar', { session: false }, async (err, data) => {
    try {
      if (err || !data) return sendOAuthError(res, err?.message || 'Google Calendar auth failed', 401);
      if (!req.query.state) return sendOAuthError(res, 'Missing state', 400);

      const state = jwt.verify(req.query.state, process.env.JWT_SECRET);
      if (state.purpose !== 'google-calendar') return sendOAuthError(res, 'Invalid state', 400);

      const update = {
        googleAccessToken: data.tokens.access_token,
        googleTokenExpiry: data.tokens.expiry_date,
        googleTokens: data.tokens
      };
      if (data.tokens.refresh_token) {
        update.googleRefreshToken = data.tokens.refresh_token;
      }

      const user = await User.findByIdAndUpdate(state.id, { $set: update }, { new: true });
      if (!user) return sendOAuthError(res, 'User not found', 404);

      return sendOAuthSuccess(res, signToken(user));
    } catch (callbackErr) {
      return sendOAuthError(res, callbackErr.message, 401);
    }
  })(req, res, next);
});

// PATCH /api/auth/profile
router.patch('/profile', auth, async (req, res) => {
  const { username, email, theme } = req.body;

  try {
    const updateData = {};
    if (username !== undefined) updateData.username = username;
    if (theme !== undefined) updateData.theme = theme;
    
    // Block direct email changes - must use email change flow
    if (email !== undefined) {
      const user = await User.findById(req.user.id);
      if (email !== user.email) {
        return res.status(400).json({ msg: 'Use email change flow to update email' });
      }
    }

    const user = await User.findByIdAndUpdate(
      req.user.id,
      { $set: updateData },
      { new: true, runValidators: true }
    );

    if (!user) return res.status(404).json({ msg: 'User not found' });
    const userObj = user.toObject();
    userObj.hasPassword = !!user.password;
    delete userObj.password;
    res.json(userObj);
  } catch (err) {
    console.error('Update profile error:', err);
    if (err.name === 'ValidationError') {
      return res.status(400).json({ msg: Object.values(err.errors)[0].message });
    }
    res.status(500).json({ msg: 'Server error' });
  }
});

// POST /api/auth/change-password
router.post('/change-password', auth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ msg: 'User not found' });

    if (user.password) {
      const isMatch = await bcrypt.compare(currentPassword, user.password);
      if (!isMatch) {
        return res.status(400).json({ msg: 'Current password is incorrect' });
      }
    }

    if (!validatePassword(newPassword)) {
      return res.status(400).json({ msg: 'Password must be 6+ chars with upper, lower, number & symbol' });
    }

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);
    await user.save();

    res.json({ msg: 'Password updated successfully' });
  } catch (err) {
    console.error('Change password error:', err.message);
    res.status(500).send('Server error');
  }
});

// POST /api/auth/request-email-change - Step 1: Send OTP to current email
router.post('/request-email-change', auth, async (req, res) => {
  let { newEmail } = req.body;
  if (!newEmail) return res.status(400).json({ msg: 'New email is required' });

  newEmail = newEmail.toLowerCase().trim();
  
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ msg: 'User not found' });
    
    const currentEmail = user.email.toLowerCase().trim();
    if (newEmail === currentEmail) {
      return res.status(400).json({ msg: 'This is already your current email address. Please enter a different email.' });
    }
    
    const existing = await User.findOne({ email: newEmail });
    if (existing) {
      return res.status(400).json({ msg: 'This email is already logged in with a different account. Please try again with another email.' });
    }

    await OTP.deleteMany({ userId: user.id, type: { $in: ['email-change-old', 'email-change-new'] } });

    const oldEmailOtp = Math.floor(100000 + Math.random() * 900000).toString();

    await OTP.create({
      userId: user.id,
      email: user.email,
      newEmail,
      otp: oldEmailOtp,
      type: 'email-change-old'
    });

    try {
      await sendOTPEmail(user.email, oldEmailOtp, 'email-change-old', { newEmail });
      res.json({ success: true, msg: 'OTP sent to current email' });
    } catch (emailErr) {
      console.error('SendOTP Error:', emailErr.message);
      res.json({ 
        success: true, 
        msg: 'Email service unavailable. Use this OTP:', 
        otp: oldEmailOtp,
        devMode: true 
      });
    }
  } catch (err) {
    console.error('Request email change error:', err.message);
    res.status(500).json({ msg: 'Server error' });
  }
});

// POST /api/auth/verify-old-email - Step 2: Verify old email + send OTP to new email
router.post('/verify-old-email', auth, async (req, res) => {
  const { otp } = req.body;
  
  try {
    const oldOtpDoc = await OTP.findOne({ userId: req.user.id, otp, type: 'email-change-old' });
    if (!oldOtpDoc) return res.status(400).json({ msg: 'Invalid or expired OTP' });

    const newEmailOtp = Math.floor(100000 + Math.random() * 900000).toString();

    await OTP.create({
      userId: req.user.id,
      email: oldOtpDoc.newEmail,
      otp: newEmailOtp,
      type: 'email-change-new',
      newEmail: oldOtpDoc.newEmail
    });

    try {
      await sendOTPEmail(oldOtpDoc.newEmail, newEmailOtp, 'email-change-new');
      res.json({ success: true, msg: 'OTP sent to new email' });
    } catch (emailErr) {
      console.error('SendOTP Error:', emailErr.message);
      res.json({ 
        success: true, 
        msg: 'Email service unavailable. Use this OTP:', 
        otp: newEmailOtp,
        devMode: true 
      });
    }
  } catch (err) {
    console.error('Verify old email error:', err.message);
    res.status(500).json({ msg: 'Server error' });
  }
});

// PATCH /api/auth/confirm-email-change - Step 3: Final update
router.patch('/confirm-email-change', auth, async (req, res) => {
  const { otp } = req.body;
  
  try {
    const newOtpDoc = await OTP.findOne({ userId: req.user.id, otp, type: 'email-change-new' });
    if (!newOtpDoc) return res.status(400).json({ msg: 'Invalid or expired OTP' });

    // Check if old email was verified
    const oldOtpDoc = await OTP.findOne({ userId: req.user.id, type: 'email-change-old' });
    if (!oldOtpDoc) return res.status(400).json({ msg: 'Verify old email first' });

    const user = await User.findByIdAndUpdate(
      req.user.id,
      { email: newOtpDoc.newEmail },
      { new: true }
    );

    await OTP.deleteMany({ userId: req.user.id, type: { $in: ['email-change-old', 'email-change-new'] } });
    const userObj = user.toObject();
    userObj.hasPassword = !!user.password;
    delete userObj.password;

    const token = signToken(user);
    res.json({ token, user: userObj });
  } catch (err) {
    console.error('Confirm email change error:', err.message);
    res.status(500).json({ msg: 'Server error' });
  }
});

module.exports = router;

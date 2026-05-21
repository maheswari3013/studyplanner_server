const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const OTP = require('../models/OTP');
const auth = require('../middleware/auth');
const { sendOTPEmail } = require('../utils/sendEmail');

const validatePassword = (password) => {
  const regex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{6,}$/;
  return regex.test(password);
};

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { username, email, password } = req.body;

  try {
    if (!username ||!email ||!password) {
      return res.status(400).json({ msg: 'Please provide all fields' });
    }

    if (!validatePassword(password)) {
      return res.status(400).json({ msg: 'Password must be 6+ chars with upper, lower, number & symbol' });
    }

    let user = await User.findOne({ email });
    if (user) return res.status(400).json({ msg: 'User already exists' });

    await OTP.deleteMany({ email, type: 'register' });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    await OTP.create({ username, email, password: hashedPassword, otp, type: 'register' });
    await sendOTPEmail(email, otp, 'register');

    res.json({ success: true, msg: 'OTP sent to your email' });
  } catch (err) {
    console.error('Register error:', err.message);
    res.status(500).json({ msg: 'Failed to send OTP' });
  }
});

// POST /api/auth/verify-register
router.post('/verify-register', async (req, res) => {
  const { email, otp } = req.body;

  try {
    const otpDoc = await OTP.findOne({ email, otp, type: 'register' });
    if (!otpDoc) return res.status(400).json({ msg: 'Invalid or expired OTP' });

    const user = new User({
      username: otpDoc.username,
      email: otpDoc.email,
      password: otpDoc.password
    });
    await user.save();
    await OTP.deleteMany({ email, type: 'register' });

    const payload = { id: user._id };
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
          theme: user.theme
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

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ msg: 'Invalid credentials' });


    const payload = { id: user._id };
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
          role: user.role
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
    await sendOTPEmail(email, otp, 'reset');

    res.json({ success: true, msg: 'Reset OTP sent to your email' });
  } catch (err) {
    console.error('Forgot password error:', err.message);
    res.status(500).json({ msg: 'Failed to send OTP' });
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
    const user = await User.findById(req.user.id).select('-password');
    if (!user) return res.status(404).json({ msg: 'User not found' });
    res.json(user);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// PATCH /api/auth/profile
router.patch('/profile', auth, async (req, res) => {
  const { username, email, theme } = req.body;

  try {
    const updateData = {};
    if (username!== undefined) updateData.username = username;
    if (email!== undefined) updateData.email = email;
    if (theme!== undefined) updateData.theme = theme;

    if (email) {
      const existing = await User.findOne({ email, _id: { $ne: req.user.id } });
      if (existing) {
        return res.status(400).json({ msg: 'Email already in use' });
      }
    }

    const user = await User.findByIdAndUpdate(
      req.user.id,
      { $set: updateData },
      { new: true, runValidators: true }
    ).select('-password');

    if (!user) return res.status(404).json({ msg: 'User not found' });
    res.json(user);
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

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(400).json({ msg: 'Current password is incorrect' });
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

module.exports = router;
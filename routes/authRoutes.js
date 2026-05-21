const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const OTP = require('../models/OTP');
const auth = require('../middleware/auth');
const { sendOTPEmail } = require('../utils/sendEmail');

// POST /api/auth/send-otp - Step 1 of register
router.post('/send-otp', async (req, res) => {
  const { name, email, password } = req.body;
  
  try {
    if (!name ||!email ||!password) {
      return res.status(400).json({ msg: 'Please provide all fields' });
    }

    let user = await User.findOne({ email });
    if (user) return res.status(400).json({ msg: 'User already exists' });

    // Password validation
    if (password.length < 8) {
      return res.status(400).json({ msg: 'Password must be at least 8 characters' });
    }

    await OTP.deleteMany({ email }); // Remove old OTPs
    
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    await OTP.create({ name, email, password: hashedPassword, otp });
    await sendOTPEmail(email, otp);

    res.json({ success: true, msg: 'OTP sent to your email' });
  } catch (err) {
    console.error('Send OTP error:', err.message);
    res.status(500).json({ msg: 'Failed to send OTP' });
  }
});

// POST /api/auth/verify-otp - Step 2 of register
router.post('/verify-otp', async (req, res) => {
  const { email, otp } = req.body;
  
  try {
    const otpDoc = await OTP.findOne({ email, otp });
    if (!otpDoc) return res.status(400).json({ msg: 'Invalid or expired OTP' });

    const user = new User({ 
      name: otpDoc.name, 
      email: otpDoc.email, 
      password: otpDoc.password 
    });
    await user.save();
    await OTP.deleteMany({ email });

    const payload = { id: user._id };
    jwt.sign(
      payload,
      process.env.JWT_SECRET,
      { expiresIn: '5d' },
      (err, token) => {
        if (err) throw err;
        const userData = { 
          _id: user._id,
          name: user.name, 
          email: user.email,
          theme: user.theme
        };
        res.json({ token, user: userData });
      }
    );
  } catch (err) {
    console.error('Verify OTP error:', err.message);
    res.status(500).json({ msg: 'Server error' });
  }
});

// POST /api/auth/login - Direct login, no OTP
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
          name: user.name, 
          email: user.email,
          theme: user.theme
        };
        res.json({ token, user: userData });
      }
    );
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).send('Server error');
  }
});

// GET /api/auth/user - Get current user
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
  const { name, email, theme } = req.body;

  try {
    const updateData = {};
    if (name!== undefined) updateData.name = name;
    if (email!== undefined) updateData.email = email;
    if (theme!== undefined) updateData.theme = theme;

    if (email) {
      const existing = await User.findOne({ email, _id: { $ne: req.user._id } });
      if (existing) {
        return res.status(400).json({ msg: 'Email already in use' });
      }
    }

    const user = await User.findByIdAndUpdate(
      req.user._id,
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
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ msg: 'User not found' });

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(400).json({ msg: 'Current password is incorrect' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ msg: 'New password must be at least 6 characters' });
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
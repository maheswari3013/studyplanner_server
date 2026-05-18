const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const nodemailer = require('nodemailer'); // changed
const User = require('../models/User');
const OTP = require('../models/OTP');
const auth = require('../middleware/auth');

// Brevo SMTP setup - replaces Resend
const transporter = nodemailer.createTransport({
  host: "smtp-relay.brevo.com",
  port: 587,
  secure: false,
  auth: {
    user: process.env.BREVO_USER,
    pass: process.env.BREVO_KEY
  }
});

// POST /api/auth/send-otp
router.post('/send-otp', async (req, res) => {
  console.log('HIT /send-otp route at', new Date().toISOString())
  console.log('Body:', req.body)
  
  const { email } = req.body;
  if (!email) {
    console.log('No email provided')
    return res.status(400).json({ msg: 'Email required' });
  }

  try {
    const otp = crypto.randomInt(100000, 999999).toString();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 min

    console.log('Generating OTP for:', email)
    await OTP.deleteMany({ email });
    await OTP.create({ email, otp, expiresAt });
    console.log('OTP saved to DB:', otp)

    console.log('Sending via Brevo...')
    await transporter.sendMail({
      from: '"StudyPlanner" <dmahi3224@gmail.com>', // Your gmail now
      to: email, // Now works for ANY email
      subject: 'Your StudyPlanner OTP Code',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px;">
          <h2>Your OTP Code</h2>
          <h1 style="color: #4F46E5; letter-spacing: 5px;">${otp}</h1>
          <p>This code expires in 15 minutes.</p>
          <p>If you didn't request this, ignore this email.</p>
        </div>
      `
    });

    console.log('Mail sent successfully to:', email)
    res.json({ msg: 'OTP sent successfully' });
    
  } catch (err) {
    console.error('SEND OTP ERROR:', err.message);
    res.status(500).json({ msg: 'Failed to send OTP' });
  }
});

// POST /api/auth/login - requires OTP
router.post('/login', async (req, res) => {
  const { email, password, otp } = req.body;
  
  try {
    const otpRecord = await OTP.findOne({ email, otp });
    if (!otpRecord) return res.status(400).json({ msg: 'Invalid OTP' });
    if (otpRecord.expiresAt < new Date()) return res.status(400).json({ msg: 'OTP expired' });

    await OTP.deleteOne({ _id: otpRecord._id });

    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ msg: 'Invalid credentials' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ msg: 'Invalid credentials' });

    const payload = { id: user.id };
    jwt.sign(
      payload,
      process.env.JWT_SECRET,
      { expiresIn: '5d' },
      (err, token) => {
        if (err) throw err;
        const userData = { id: user.id, name: user.name, email: user.email };
        res.json({ token, user: userData });
      }
    );
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).send('Server error');
  }
});

// POST /api/auth/register - requires OTP
router.post('/register', async (req, res) => {
  const { name, email, password, otp } = req.body;
  
  try {
    const otpRecord = await OTP.findOne({ email, otp });
    if (!otpRecord) return res.status(400).json({ msg: 'Invalid OTP' });
    if (otpRecord.expiresAt < new Date()) return res.status(400).json({ msg: 'OTP expired' });

    await OTP.deleteOne({ _id: otpRecord._id });

    let user = await User.findOne({ email });
    if (user) return res.status(400).json({ msg: 'User already exists' });

    user = new User({ name, email, password });
    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(password, salt);
    await user.save();

    const payload = { id: user.id };
    jwt.sign(
      payload,
      process.env.JWT_SECRET,
      { expiresIn: '5d' },
      (err, token) => {
        if (err) throw err;
        const userData = { id: user.id, name: user.name, email: user.email };
        res.json({ token, user: userData });
      }
    );
  } catch (err) {
    console.error('Register error:', err.message);
    res.status(500).json({ msg: 'Server error' });
  }
});

// GET /api/auth/user - Get logged in user data
router.get('/user', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) return res.status(404).json({ msg: 'User not found' });
    res.json(user);
  } catch (err) {
    console.error('Get user error:', err.message);
    res.status(500).json({ msg: 'Server error' });
  }
});

// PATCH /api/auth/profile - Update user profile
router.patch('/profile', auth, async (req, res) => {
  const { name, email } = req.body;
  try {
    const existing = await User.findOne({ email, _id: { $ne: req.user.id } });
    if (existing) {
      return res.status(400).json({ msg: 'Email already in use' });
    }

    const user = await User.findByIdAndUpdate(
      req.user.id,
      { name, email },
      { new: true, runValidators: true }
    ).select('-password');
    
    res.json(user);
  } catch (err) {
    console.error('Update profile error:', err.message);
    res.status(500).send('Server error');
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
const mongoose = require('mongoose');

const OTPSchema = new mongoose.Schema({
  username: { type: String },
  email: { type: String, required: true },
  password: { type: String },
  otp: { type: String, required: true },
  type: {
    type: String,
    enum: ['register', 'reset', 'email-change-old', 'email-change-new'],
    required: true
  },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  newEmail: { type: String },
  createdAt: { type: Date, default: Date.now, expires: 600 } // 10 min expiry
});

module.exports = mongoose.models.OTP || mongoose.model('OTP', OTPSchema);
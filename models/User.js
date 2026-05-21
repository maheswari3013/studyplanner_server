const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true
  },
  email: {
    type: String,
    required: true,
    unique: true
  },
  password: {
    type: String,
    required: true
  },
  date: {
    type: Date,
    default: Date.now
  },
  googleTokens: {
    access_token: String,
    refresh_token: String,
    expiry_date: Number
  },
  subjectConfidence: { type: Map, of: Number, default: {} },
  showAffirmations: { type: Boolean, default: true },
  theme: {
    type: String,
    enum: ['light', 'dark'],
    default: 'light'
  },
  subscriptions: [{
    endpoint: String,
    expirationTime: Number,
    keys: {
      p256dh: String,
      auth: String
    }
  }],
  lastActive: { type: Date, default: Date.now },
  role: {
    type: String,
    enum: ['user', 'admin'],
    default: 'user',
    index: true
  }
});

module.exports = mongoose.models.User || mongoose.model('User', UserSchema);
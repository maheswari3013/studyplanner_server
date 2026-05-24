const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true
  },
  name: String,
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  password: {
    type: String,
    required: function() {
      return !this.googleId;
    }
  },
  googleId: {
    type: String,
    unique: true,
    sparse: true,
    index: true
  },
  avatar: String,
  googleAccessToken: String,
  googleRefreshToken: String,
  googleTokenExpiry: Number,
  date: {
    type: Date,
    default: Date.now
  },
  googleTokens: {
    access_token: String,
    refresh_token: { type: String, index: true }, 
    expiry_date: Number,
    scope: String,       
    token_type: String
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

// Virtual for backwards compatibility with old isAdmin checks
UserSchema.virtual('isAdmin').get(function() {
  return this.role === 'admin';
});

UserSchema.set('toJSON', { virtuals: true });
UserSchema.set('toObject', { virtuals: true });

module.exports = mongoose.models.User || mongoose.model('User', UserSchema);

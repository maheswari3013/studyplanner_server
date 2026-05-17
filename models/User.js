const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  name: {
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
  // NEW: Confidence Tracker
  subjectConfidence: { type: Map, of: Number, default: {} }, // { "Math": 7, "Physics": 5 }
  showAffirmations: { type: Boolean, default: true }
});

module.exports = mongoose.models.User || mongoose.model('User', UserSchema);
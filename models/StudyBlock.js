const mongoose = require('mongoose');

const StudyBlockSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  examId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Exam',
    required: false
  },
  subject: {
    type: String,
    required: true
  },
  topic: {
    type: String,
    required: true
  },
  date: {
    type: String, // "2026-05-20" - STRING not Date
    required: true
  },
  time: {
    type: String, // "09:50" IST for UI display
    required: true
  },
  startTime: {
    type: String, // "04:20" UTC for cron - ONLY ONE startTime
    required: true
  },
  duration: {
    type: Number, // planned minutes
    required: true
  },
  completed: {
    type: Boolean,
    default: false
  },
  missed: {
    type: Boolean,
    default: false
  },
  type: {
    type: String,
    enum: ['Study', 'Review', 'Break'],
    default: 'Study'
  },
  intervalDay: Number,
  isGenerated: {
    type: Boolean,
    default: false
  },
  isBreak: {
    type: Boolean,
    default: false
  },
  priority: Number,
  color: {
    type: String,
    default: '#3B82F6'
  },
  rescheduledFrom: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'StudyBlock'
  },
  actualDuration: { type: Number, default: 0 },
  loggedAt: Date
}, { timestamps: true });

StudyBlockSchema.index({ user: 1, date: 1 });
StudyBlockSchema.index({ user: 1, subject: 1, date: 1 });
StudyBlockSchema.index({ date: 1, startTime: 1 });

module.exports = mongoose.model('StudyBlock', StudyBlockSchema);
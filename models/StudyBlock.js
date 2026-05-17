const mongoose = require('mongoose');

const StudyBlockSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  examId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Exam',
    required:false
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
    type: Date,
    required: true
  },
  startTime: {
    type: String // "14:30" format
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
  rescheduledFrom: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'StudyBlock'
  },
  // NEW: Study Log History
  actualDuration: { type: Number, default: 0 }, // actual minutes logged
  loggedAt: Date
}, { timestamps: true });

StudyBlockSchema.index({ userId: 1, date: 1 });
StudyBlockSchema.index({ userId: 1, subject: 1, date: 1 });

module.exports = mongoose.model('StudyBlock', StudyBlockSchema);
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
    type: String, 
    required: true
  },
  time: {
    type: String, 
    required: true
  },
  startTime: {
    type: String, 
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
  status: {
    type: String,
    enum: ['scheduled', 'completed', 'missed', 'overdue'],
    default: 'scheduled'
  },
  actualDuration: { type: Number, default: 0 },
  loggedAt: Date,
  
  // Error 6: Fields for overdue handling + tracking
  notifiedOverdue: { type: Boolean, default: false },
  completedAt: Date,
  missedAt: Date
  
}, { timestamps: true });

StudyBlockSchema.index({ user: 1, date: 1 });
StudyBlockSchema.index({ user: 1, subject: 1, date: 1 });
StudyBlockSchema.index({ date: 1, startTime: 1 });
StudyBlockSchema.index({ date: 1, notifiedOverdue: 1, completed: 1, missed: 1 });
StudyBlockSchema.index({ user: 1, isBreak: 1, completed: 1 });
StudyBlockSchema.index({ user: 1, examId: 1 }); 

module.exports = mongoose.model('StudyBlock', StudyBlockSchema);
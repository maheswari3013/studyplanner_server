const mongoose = require('mongoose');

const ExamSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  subject: {
    type: String,
    required: true
  },
  examDate: {
    type: Date,
    required: true
  },
  time: {
    type: String,
    default: "09:00"
  },
  location: {
    type: String,
    default: ''
  },
  color: {
    type: String,
    default: '#3B82F6'
  },
  difficulty: {
    type: Number,
    min: 1,
    max: 5,
    default: 3
  },
  currentKnowledge: {
    type: Number,
    min: 1,
    max: 5,
    default: 3
  },
  priority: {
    type: Number,
    default: 3
  },
  totalHours: {
    type: Number,
    required: false,
    min: 0
  },
  syllabusTopics: [{
    name: { type: String, required: true },
    hours: { type: Number, required: false, default: 1 }
  }],
  availableHours: {
    mon: { type: Number, default: 4 },
    tue: { type: Number, default: 4 },
    wed: { type: Number, default: 4 },
    thu: { type: Number, default: 4 },
    fri: { type: Number, default: 4 },
    sat: { type: Number, default: 6 },
    sun: { type: Number, default: 6 }
  },
  breakRatio: {
    study: { type: Number, default: 50 },
    break: { type: Number, default: 10 }
  },
  totalScheduledHours: {
    type: Number,
    default: 0
  },
  completedHours: {
    type: Number,
    default: 0
  },
  status: {
    type: String,
    default: 'Pending'
  },
  rescheduledFrom: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'StudyBlock'
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  syllabusTopics: [{
  name: { type: String, required: true },
  hours: { type: Number, default: 0 },
  missedHours: { type: Number, default: 0 } // ADD THIS LINE
}]
});

module.exports = mongoose.models.Exam || mongoose.model('Exam', ExamSchema);
const mongoose = require('mongoose');

const ExamSchema = new mongoose.Schema({
  userId: {
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
    min: 1,
    max: 5,
    default: 3
  },
  // Mode 1 - hours per subject
  totalHours: {
    type: Number,
    required: false,
    min: 0
  },
  // Mode 2 - accepts strings OR {name, hours} objects
  syllabusTopics: {
    type: [mongoose.Schema.Types.Mixed],
    default: []
  },
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
  status: {
    type: String,
    default: 'Pending'
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.models.Exam || mongoose.model('Exam', ExamSchema);
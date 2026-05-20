const mongoose = require('mongoose')
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
  location: {
    type: String,
    default: ''
  },
  color: {  // ← Keep only this one, delete the duplicate below
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
  // DELETE THIS DUPLICATE ↓
  // color: {
  //   type: String,
  //   default: '#3B82F6'
  // },
  rescheduledFrom: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'StudyBlock'
  },
  totalHours: {
    type: Number,
    required: false,
    min: 0
  },
  syllabusTopics: [{
    name: { type: String, required: true },
    hours: { type: Number, required: true }
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
    study: { type: Number, default: 25 },
    break: { type: Number, default: 5 }
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
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.models.Exam || mongoose.model('Exam', ExamSchema);
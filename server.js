const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors'); // add this
require('dotenv').config();

const app = express();

const allowedOrigins = [
  'http://localhost:5173',
  'https://studyplanner-client.vercel.app'
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

app.use(express.json());
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/exams', require('./routes/examRoutes'));
app.use('/api/schedule', require('./routes/scheduleRoutes'));

mongoose.connect(process.env.MONGO_URI).then(() => console.log('MongoDB connected'));
app.listen(process.env.PORT || 5000, () => console.log('Server running'));
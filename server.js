const express = require('express');
const mongoose = require('mongoose');
require('dotenv').config();

const app = express();

app.use((req, res, next) => {
  console.log('CORS Middleware:', req.method, req.url);
  res.header('Access-Control-Allow-Origin', 'http://localhost:5173');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-auth-token');
  res.header('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/exams', require('./routes/examRoutes')); 
app.use('/api/schedule', require('./routes/scheduleRoutes'));


mongoose.connect(process.env.MONGO_URI).then(() => console.log('MongoDB connected'));
app.listen(5000, () => console.log('Server running on port 5000'));
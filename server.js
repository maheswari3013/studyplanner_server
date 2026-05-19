const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');
const errorHandler = require('./middleware/errorHandler');
require('dotenv').config();

// Connect to MongoDB
connectDB();

const app = express();

// Whitelist origins - add all your frontend URLs here
const allowedOrigins = [
  'http://localhost:5173',
  'https://studyplanner-client.vercel.app'
];

// CORS config with logging
const corsOptions = {
  origin: function (origin, callback) {
    console.log('Incoming request from origin:', origin);
    
    // Allow requests with no origin like Postman or mobile apps
    if (!origin) return callback(null, true);
    
    // Allow whitelisted origins + all Vercel preview deployments
    if (
      allowedOrigins.includes(origin) || 
      origin.endsWith('.vercel.app')
    ) {
      return callback(null, true);
    }
    
    // Block everything else
    return callback(new Error(`CORS blocked: ${origin} not allowed`));
  },
  credentials: true,
  optionsSuccessStatus: 200 // Some legacy browsers choke on 204
};

// Enable CORS for all routes
app.use(cors(corsOptions));

// Handle preflight OPTIONS for all routes - Express 5 compatible
app.options(/.*/, cors(corsOptions));

// Body parser middleware
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// API Routes
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/exams', require('./routes/examRoutes'));
app.use('/api/schedule', require('./routes/scheduleRoutes'));
app.use('/api/admin', require('./routes/adminRoutes'));
app.use('/api/notifications', require('./routes/notificationRoutes'));

// Health check for Render
app.get('/', (req, res) => res.send('API Running'));

// Custom error handler - must be last
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
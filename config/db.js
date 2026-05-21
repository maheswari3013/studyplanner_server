const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 5000, // Fail fast instead of hanging 10s
    });
  } catch (err) {
    console.error('DB Error:', err.message);
    throw err;
  }
};

module.exports = connectDB;
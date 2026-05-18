const errorHandler = (err, req, res, next) => {
  console.error(err.stack);

  // Mongoose bad ObjectId
  if (err.name === 'CastError') {
    return res.status(400).json({ msg: 'Invalid ID format' });
  }

  // Mongoose validation error
  if (err.name === 'ValidationError') {
    const messages = Object.values(err.errors).map(val => val.message);
    return res.status(400).json({ msg: messages.join(', ') });
  }

  // Mongoose duplicate key
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue)[0];
    return res.status(400).json({ msg: `${field} already exists` });
  }

  // JWT errors from auth middleware
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({ msg: 'Token is not valid' });
  }

  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({ msg: 'Token expired' });
  }

  // CORS error from your server.js
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ msg: 'CORS error: Origin not allowed' });
  }

  // Default to 500 server error
  res.status(err.statusCode || 500).json({
    msg: err.message || 'Server Error'
  });
};

module.exports = errorHandler;
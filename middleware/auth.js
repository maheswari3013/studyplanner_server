const jwt = require('jsonwebtoken');
const User = require('../models/User'); // You need this import

module.exports = async function(req, res, next) { // ← add async here
  const authHeader = req.header('Authorization');
  const token = authHeader?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ msg: 'No token, authorization denied' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { _id: decoded.id };
    
    // Move the await INSIDE the function
    await User.findByIdAndUpdate(decoded.id || decoded.user?.id, { lastActive: new Date() });
    next();
  } catch (err) {
    console.error('JWT Error:', err.message);
    res.status(401).json({ msg: 'Token is not valid' });
  }
};
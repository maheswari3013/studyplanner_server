const jwt = require('jsonwebtoken');
const User = require('../models/User'); // You need this import

module.exports = async function(req, res, next) { // ← add async here
  const token = req.header('x-auth-token');

  if (!token) {
    return res.status(401).json({ msg: 'No token, authorization denied' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { _id: decoded.id };
    
    // Move the await INSIDE the function
    await User.findByIdAndUpdate(decoded.id, { lastActive: new Date() }); // ← fixed
    next();
  } catch (err) {
    res.status(401).json({ msg: 'Token is not valid' });
  }
};
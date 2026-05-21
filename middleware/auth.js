const jwt = require('jsonwebtoken');
const User = require('../models/User');

module.exports = async function(req, res, next) {
  const authHeader = req.header('Authorization');
  const token = authHeader?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ msg: 'No token, authorization denied' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const userId = decoded.id || decoded.user?.id;
    if (!userId) {
      return res.status(401).json({ msg: 'Invalid token payload' });
    }
      
    req.user = { 
  id: userId,
  role: decoded.role,   
  email: decoded.email  };
    
    await User.findByIdAndUpdate(userId, { lastActive: new Date() });
    next();
  } catch (err) {
    console.error('JWT Error:', err.message);
    res.status(401).json({ msg: 'Token is not valid' });
  }
};
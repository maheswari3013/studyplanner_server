const User = require('../models/User');

module.exports = async function(req, res, next) {
  try {
    const user = await User.findById(req.user.id);
    
    if (user && user.role === 'admin') {
      next();
    } else {
      return res.status(403).json({ msg: 'Admin access required' });
    }
  } catch (err) {
    console.error('isAdmin middleware error:', err);
    return res.status(500).json({ msg: 'Server error' });
  }
};
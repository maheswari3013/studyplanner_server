const User = require('../models/User');

module.exports = async function(req, res, next) {
  try {
    const user = await User.findById(req.user._id);
    if (user && user.isAdmin) {
      next();
    } else {
      res.status(403).json({ msg: 'Admin access required' });
    }
  } catch (err) {
    res.status(500).json({ msg: 'Server error' });
  }
};
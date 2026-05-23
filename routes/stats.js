const express = require('express');
const router = express.Router();

router.get('/memory', (req, res) => {
  const memUsage = process.memoryUsage();
  res.json({
    memoryUsed: Number((memUsage.heapUsed / 1024 / 1024 / 1024).toFixed(2)),
    unit: 'GB'
  });
});

module.exports = router;

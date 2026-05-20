const mongoose = require('mongoose');
const User = require('./models/User');
require('dotenv').config();

mongoose.connect(process.env.MONGO_URI).then(async () => {
  const result = await User.updateOne(
    { email: "replace-with-your-email@gmail.com" }, // Change this
    { $set: { role: "admin" } }
  );
  console.log('Updated:', result);
  mongoose.connection.close();
  process.exit(0);
}).catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
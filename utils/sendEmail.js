const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransporter({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  },
  family: 4, // Force IPv4 - fixes Render
  tls: {
    rejectUnauthorized: false
  }
});

const sendOTPEmail = async (email, otp) => {
  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: email,
    subject: 'Your StudyPlanner OTP',
    html: `<h2>Your OTP: ${otp}</h2><p>Valid for 10 minutes.</p>`
  });
};

module.exports = { sendOTPEmail };
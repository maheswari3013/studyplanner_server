const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  },
  family: 4, // This fixes ENETUNREACH on Render
  tls: { rejectUnauthorized: false }
});

const sendOTPEmail = async (email, otp) => {
  await transporter.sendMail({
    from: `"StudyPlanner" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: 'Your StudyPlanner OTP',
    html: `<h2>Your OTP: ${otp}</h2><p>Valid for 10 minutes.</p>`
  });
  console.log('OTP sent to:', email);
};

module.exports = { sendOTPEmail };
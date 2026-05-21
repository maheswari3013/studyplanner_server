const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  },
  family: 4, // Force IPv4 - fixes ENETUNREACH on Render
  tls: {
    rejectUnauthorized: false
  }
});

const sendOTPEmail = async (email, otp) => {
  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: email,
    subject: 'Your StudyPlanner OTP',
    html: `
      <div style="font-family: Arial; padding: 20px;">
        <h2>Your OTP: ${otp}</h2>
        <p>This code is valid for 10 minutes. Do not share it.</p>
      </div>
    `
  });
};

module.exports = { sendOTPEmail };
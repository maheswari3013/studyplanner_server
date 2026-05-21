const nodemailer = require('nodemailer');
require('dotenv').config();

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

transporter.verify((error, success) => {
  if (error) {
    console.log('Gmail SMTP error:', error);
  } else {
    console.log('Gmail SMTP ready');
  }
});

const sendOTPEmail = async (to, otp, type = 'register') => {
  const subject = type === 'register'
    ? 'Verify your StudyPlanner account'
    : 'Reset your StudyPlanner password';

  const heading = type === 'register'
    ? 'Verify your email'
    : 'Reset your password';

  const mailOptions = {
    from: `StudyPlanner <${process.env.EMAIL_USER}>`,
    to,
    subject,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #e5e7eb; border-radius: 8px;">
        <h2 style="color: #111827;">${heading}</h2>
        <p style="color: #374151; font-size: 16px;">Your OTP code is:</p>
        <div style="background: #f3f4f6; padding: 16px; border-radius: 6px; text-align: center; margin: 20px 0;">
          <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #2563eb;">${otp}</span>
        </div>
        <p style="color: #6b7280; font-size: 14px;">This code expires in 10 minutes. If you didn't request this, ignore this email.</p>
      </div>
    `
  };

  await transporter.sendMail(mailOptions);
};

module.exports = { sendOTPEmail };
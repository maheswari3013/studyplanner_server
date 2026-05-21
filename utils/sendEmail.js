const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  },
  family: 4,
  connectionTimeout: 5000,
  greetingTimeout: 5000,
  socketTimeout: 5000,
  tls: { rejectUnauthorized: false }
});

const sendOTPEmail = async (email, otp, type = 'register') => {
  const subject = type === 'register' ? 'Verify Your StudyPlanner Account' : 'Reset Your StudyPlanner Password';
  await transporter.sendMail({
    from: `"StudyPlanner" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: subject,
    html: `<h2>Your OTP: ${otp}</h2><p>Valid for 10 minutes. Do not share this code.</p>`
  });
};

module.exports = { sendOTPEmail };
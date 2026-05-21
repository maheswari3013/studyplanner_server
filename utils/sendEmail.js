const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS // Gmail App Password, not regular password
  }
});

const sendOTPEmail = async (email, otp) => {
  await transporter.sendMail({
    from: `"StudyPlanner" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: 'Verify your StudyPlanner account',
    html: `
      <div style="font-family:Arial,sans-serif;padding:20px">
        <h2>Email Verification</h2>
        <p>Your OTP code is:</p>
        <h1 style="letter-spacing:8px">${otp}</h1>
        <p>This code expires in 10 minutes.</p>
      </div>
    `
  });
};

module.exports = { sendOTPEmail };
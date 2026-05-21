const sgMail = require('@sendgrid/mail');
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const sendOTPEmail = async (email, otp, type = 'register') => {
  const subject = type === 'register' ? 'Verify Your StudyPlanner Account' : 'Reset Your StudyPlanner Password';
  const msg = {
    to: email,
    from: 'dmahi3224@gmail.com', 
    subject: subject,
    html: `
      <div style="font-family: Arial, sans-serif; padding: 20px;">
        <h2>StudyPlanner OTP</h2>
        <p>Your OTP code is:</p>
        <h1 style="color: #4CAF50; letter-spacing: 5px;">${otp}</h1>
        <p>This code expires in 10 minutes.</p>
      </div>
    `
  };
  await sgMail.send(msg);
};

module.exports = { sendOTPEmail };
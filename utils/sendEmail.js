const sgMail = require('@sendgrid/mail');
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const sendOTPEmail = async (email, otp, type = 'register', extra = {}) => {
  const templates = {
    register: {
      subject: 'Verify Your StudyPlanner Account',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 600px;">
          <h2>Welcome to StudyPlanner</h2>
          <p>Your verification code is:</p>
          <h1 style="color: #4CAF50; letter-spacing: 5px; font-size: 32px;">${otp}</h1>
          <p>This code expires in 10 minutes.</p>
          <p style="color: #666; font-size: 12px;">If you didn't request this, please ignore this email.</p>
        </div>
      `
    },
    reset: {
      subject: 'Reset Your StudyPlanner Password',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 600px;">
          <h2>Password Reset</h2>
          <p>Your verification code is:</p>
          <h1 style="color: #4CAF50; letter-spacing: 5px; font-size: 32px;">${otp}</h1>
          <p>This code expires in 10 minutes. If you didn't request this, ignore this email.</p>
        </div>
      `
    },
    'email-change-old': {
      subject: 'Verify Email Change Request',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 600px;">
          <h2>Email Change Request</h2>
          <p>Someone requested to change your StudyPlanner email to <strong>${extra.newEmail || ''}</strong></p>
          <p>Your verification code is:</p>
          <h1 style="color: #4CAF50; letter-spacing: 5px; font-size: 32px;">${otp}</h1>
          <p>This code expires in 10 minutes. If this wasn't you, change your password immediately.</p>
        </div>
      `
    },
    'email-change-new': {
      subject: 'Verify Your New Email',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 600px;">
          <h2>Verify New Email</h2>
          <p>Verify this email address for your StudyPlanner account.</p>
          <p>Your verification code is:</p>
          <h1 style="color: #4CAF50; letter-spacing: 5px; font-size: 32px;">${otp}</h1>
          <p>This code expires in 10 minutes.</p>
        </div>
      `
    }
  };

  const template = templates[type] || templates.register;
  
  const msg = {
    to: email,
    from: {
      email: 'dmahi3224@gmail.com',
      name: 'StudyPlanner'
    },
    subject: template.subject,
    html: template.html,
    tracking_settings: {
      click_tracking: { enable: false },
      open_tracking: { enable: false },
      subscription_tracking: { enable: false }
    }
  };
  
  await sgMail.send(msg);
};

module.exports = { sendOTPEmail };
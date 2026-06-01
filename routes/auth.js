import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import pool from '../db.js';
import nodemailer from 'nodemailer';
import dns from 'dns';

// Force IPv4 DNS resolution to prevent EHOSTUNREACH errors
// when connecting to smtp.gmail.com on IPv6-incompatible networks
dns.setDefaultResultOrder('ipv4first');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'your_super_secret_key';

// ─── Helper: Generate 6-digit OTP ───────────────────────────────────────────
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ─── Helper: Validate email format ──────────────────────────────────────────
function isValidEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
}

// ─── Helper: Validate password strength ─────────────────────────────────────
function validatePassword(password) {
  if (password.length < 6) return 'Password must be at least 6 characters long';
  return null;
}

// ─── Helper: Create Nodemailer transporter ──────────────────────────────────
function getTransporter() {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) return null;
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 15000,
  });
}

// ─── Helper: Send OTP Email ─────────────────────────────────────────────────
async function sendOTPEmail(email, otp, purpose = 'verification') {
  const transporter = getTransporter();
  
  const subjectMap = {
    verification: 'Verify Your NeedMate Account',
    reset: 'Reset Your NeedMate Password'
  };
  
  const headingMap = {
    verification: 'Verify Your Email',
    reset: 'Reset Your Password'
  };

  const descMap = {
    verification: 'Thank you for registering on NeedMate! Use the verification code below to complete your account setup.',
    reset: 'We received a request to reset your NeedMate password. Use the code below to proceed.'
  };

  const htmlTemplate = `
    <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 480px; margin: 0 auto; background: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.08);">
      <div style="background: linear-gradient(135deg, #0d9488 0%, #0f766e 100%); padding: 32px 24px; text-align: center;">
        <div style="width: 48px; height: 48px; background: rgba(255,255,255,0.2); border-radius: 12px; display: inline-flex; align-items: center; justify-content: center; margin-bottom: 12px;">
          <span style="color: white; font-size: 28px; font-weight: 900;">N</span>
        </div>
        <h1 style="color: white; margin: 0; font-size: 22px; font-weight: 700;">${headingMap[purpose]}</h1>
      </div>
      <div style="padding: 32px 24px;">
        <p style="color: #4b5563; font-size: 14px; line-height: 1.6; margin: 0 0 24px 0;">${descMap[purpose]}</p>
        <div style="background: #f0fdfa; border: 2px dashed #14b8a6; border-radius: 12px; padding: 20px; text-align: center; margin-bottom: 24px;">
          <p style="color: #6b7280; font-size: 12px; margin: 0 0 8px 0; font-weight: 600; text-transform: uppercase; letter-spacing: 1px;">Your Verification Code</p>
          <p style="color: #0f766e; font-size: 36px; font-weight: 800; letter-spacing: 8px; margin: 0; font-family: 'Courier New', monospace;">${otp}</p>
        </div>
        <p style="color: #9ca3af; font-size: 12px; text-align: center; margin: 0;">
          ⏱ This code expires in <strong>5 minutes</strong>. Do not share it with anyone.
        </p>
      </div>
      <div style="background: #f9fafb; padding: 16px 24px; text-align: center; border-top: 1px solid #e5e7eb;">
        <p style="color: #9ca3af; font-size: 11px; margin: 0;">NeedMate — Your Campus Concierge</p>
      </div>
    </div>
  `;

  if (!transporter) {
    // DEV MODE: No email credentials — log to console and return mock
    console.log(`\n=== MOCK EMAIL ===\nTo: ${email}\nSubject: ${subjectMap[purpose]}\nOTP: ${otp}\n==================\n`);
    return { mock: true, otp };
  }

  // PRODUCTION MODE: Send real email via Gmail SMTP
  await transporter.sendMail({
    from: `"NeedMate" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: subjectMap[purpose],
    html: htmlTemplate,
    text: `Your NeedMate ${purpose} code is: ${otp}. It expires in 5 minutes.`,
  });

  return { mock: false };
}


// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/auth/register — Step 1: Validate + send OTP email
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/register', async (req, res) => {
  const { name, email, password, student_class } = req.body;
  
  // Validate all required fields
  if (!name || !email || !password || !student_class) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  // Validate email format
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  // Validate password strength
  const pwError = validatePassword(password);
  if (pwError) {
    return res.status(400).json({ error: pwError });
  }

  try {
    // Check if email already exists in verified users
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      // Also clean up any stale pending registration for this email
      await pool.query('DELETE FROM pending_registrations WHERE email = $1', [email]);
      return res.status(400).json({ error: 'Email already registered. Please login instead.' });
    }

    // Auto-clean expired pending registrations (older than 10 minutes) to prevent table bloat
    await pool.query("DELETE FROM pending_registrations WHERE otp_expires_at < NOW() - INTERVAL '10 minutes'");

    // Hash password before storing
    const hashedPassword = await bcrypt.hash(password, 10);

    // Generate OTP
    const otp = generateOTP();
    const otpExpiresAt = new Date(Date.now() + 5 * 60000).toISOString(); // 5 minutes

    // Delete any existing pending registration for this email
    await pool.query('DELETE FROM pending_registrations WHERE email = $1', [email]);

    // Store pending registration with OTP
    await pool.query(
      'INSERT INTO pending_registrations (name, email, password, student_class, otp, otp_expires_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [name, email, hashedPassword, student_class, otp, otpExpiresAt]
    );

    // Send OTP via email — catch SMTP failures gracefully
    let emailResult;
    try {
      emailResult = await sendOTPEmail(email, otp, 'verification');
    } catch (emailErr) {
      console.error('SMTP error during registration:', emailErr.message);
      // Don't delete the pending registration — user can retry with resend-otp
      return res.status(200).json({
        message: 'Account prepared. Email delivery was slow — please use "Resend OTP" on the verification page.',
        email: email,
        emailWarning: true
      });
    }

    const response = { 
      message: 'OTP sent to your email. Please verify to complete registration.',
      email: email
    };

    // In dev mode (no email service), return OTP for testing
    if (emailResult.mock) {
      response.simulatedOtp = emailResult.otp;
    }

    res.status(200).json(response);
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Server error during registration' });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/auth/verify-registration — Step 2: Verify OTP + create account
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/verify-registration', async (req, res) => {
  const { email, otp } = req.body;

  if (!email || !otp) {
    return res.status(400).json({ error: 'Email and OTP are required' });
  }

  try {
    // Find the pending registration
    const pending = await pool.query(
      'SELECT * FROM pending_registrations WHERE email = $1',
      [email]
    );

    if (pending.rows.length === 0) {
      return res.status(404).json({ error: 'No pending registration found. Please register again.' });
    }

    const registration = pending.rows[0];

    // Check OTP match
    if (registration.otp !== otp) {
      return res.status(400).json({ error: 'Invalid verification code. Please check and try again.' });
    }

    // Check OTP expiration
    if (new Date() > new Date(registration.otp_expires_at)) {
      return res.status(400).json({ error: 'Verification code has expired. Please request a new one.' });
    }

    // Double-check no user was created in the meantime
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      await pool.query('DELETE FROM pending_registrations WHERE email = $1', [email]);
      return res.status(400).json({ error: 'Account already exists. Please login.' });
    }

    // OTP is valid — create the verified user account
    const result = await pool.query(
      'INSERT INTO users (name, email, password, student_class, is_verified) VALUES ($1, $2, $3, $4, 1) RETURNING id, name, email, student_class',
      [registration.name, email, registration.password, registration.student_class]
    );

    // Clean up the pending registration
    await pool.query('DELETE FROM pending_registrations WHERE email = $1', [email]);

    const user = result.rows[0];
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });

    res.status(201).json({ 
      message: 'Email verified successfully! Account created.',
      user, 
      token 
    });
  } catch (err) {
    console.error('Verify registration error:', err);
    res.status(500).json({ error: 'Server error during verification' });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/auth/resend-registration-otp — Resend OTP for pending registration
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/resend-registration-otp', async (req, res) => {
  const { email } = req.body;

  if (!email) return res.status(400).json({ error: 'Email is required' });

  try {
    const pending = await pool.query(
      'SELECT * FROM pending_registrations WHERE email = $1',
      [email]
    );

    if (pending.rows.length === 0) {
      return res.status(404).json({ error: 'No pending registration found. Please register again.' });
    }

    // Generate new OTP
    const otp = generateOTP();
    const otpExpiresAt = new Date(Date.now() + 5 * 60000).toISOString();

    // Update the pending registration with new OTP
    await pool.query(
      'UPDATE pending_registrations SET otp = $1, otp_expires_at = $2 WHERE email = $3',
      [otp, otpExpiresAt, email]
    );

    // Send new OTP email — catch SMTP failures gracefully
    let emailResult;
    try {
      emailResult = await sendOTPEmail(email, otp, 'verification');
    } catch (emailErr) {
      console.error('SMTP error during resend-otp:', emailErr.message);
      return res.status(200).json({
        message: 'A new code was prepared. Email delivery is slow — please wait or try resending.',
        emailWarning: true
      });
    }

    const response = { message: 'New OTP sent to your email.' };
    if (emailResult.mock) {
      response.simulatedOtp = emailResult.otp;
    }

    res.json(response);
  } catch (err) {
    console.error('Resend OTP error:', err);
    res.status(500).json({ error: 'Failed to resend OTP' });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/auth/login
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Wrong email or password. Try Forgot Password to reset.' });
    }

    const user = result.rows[0];

    // Check if account is verified
    if (!user.is_verified) {
      return res.status(403).json({ 
        error: 'Email not verified. Please verify your email first.',
        needsVerification: true,
        email: email
      });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(400).json({ error: 'Wrong email or password. Try Forgot Password to reset.' });
    }

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
    delete user.password;
    delete user.reset_otp;
    delete user.reset_otp_expires_at;

    res.json({ user, token });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error during login' });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/auth/me — Get current user profile
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/me', authenticateUser, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, email, rating_sum, rating_count, created_at FROM users WHERE id = $1', [req.user.userId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error formatting profile' });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// JWT Authentication Middleware
// ═══════════════════════════════════════════════════════════════════════════════
export function authenticateUser(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing token' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload; // { userId }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
};


// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/auth/forgot-password — Send reset OTP
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Invalid email format' });

  try {
    const check = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (check.rows.length === 0) return res.status(404).json({ error: 'Account not found. Please register first.' });
    
    const otp = generateOTP();
    const expiresAt = new Date(Date.now() + 5 * 60000).toISOString(); // 5 minutes
    
    await pool.query('UPDATE users SET reset_otp = $1, reset_otp_expires_at = $2 WHERE email = $3', [otp, expiresAt, email]);

    // Send OTP via email — catch SMTP failures gracefully
    let emailResult;
    try {
      emailResult = await sendOTPEmail(email, otp, 'reset');
    } catch (emailErr) {
      console.error('SMTP error during forgot-password:', emailErr.message);
      return res.status(200).json({
        message: 'Reset request registered. Email delivery was slow — please try resending or waiting a moment.',
        emailWarning: true
      });
    }

    const response = { message: 'Password reset OTP sent to your email.' };
    if (emailResult.mock) {
      response.simulatedOtp = emailResult.otp;
    }

    res.json(response);
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Server error processing password reset.' });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/auth/verify-otp — Verify reset OTP (does NOT reset password yet)
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/verify-otp', async (req, res) => {
  const { email, otp } = req.body;
  try {
    const result = await pool.query('SELECT reset_otp, reset_otp_expires_at FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    
    const user = result.rows[0];
    if (user.reset_otp !== otp) return res.status(400).json({ error: 'Invalid verification code.' });
    
    if (new Date() > new Date(user.reset_otp_expires_at)) {
       return res.status(400).json({ error: 'Verification code expired. Please request a new one.' });
    }
    
    res.json({ message: 'OTP verified successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Verification failed.' });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/auth/reset-password — Reset password after OTP verification
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/reset-password', async (req, res) => {
  const { email, otp, newPassword } = req.body;

  if (!email || !otp || !newPassword) {
    return res.status(400).json({ error: 'Email, OTP, and new password are required' });
  }

  const pwError = validatePassword(newPassword);
  if (pwError) return res.status(400).json({ error: pwError });

  try {
    const result = await pool.query('SELECT reset_otp, reset_otp_expires_at FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    
    if (result.rows[0].reset_otp !== otp) return res.status(400).json({ error: 'Invalid or expired code.' });
    
    if (new Date() > new Date(result.rows[0].reset_otp_expires_at)) {
      return res.status(400).json({ error: 'Reset code expired. Please request a new one.' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password = $1, reset_otp = NULL, reset_otp_expires_at = NULL WHERE email = $2', [hashedPassword, email]);
    
    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reset password.' });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/auth/admin-reset (DEV ONLY — direct password reset without OTP)
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/admin-reset', async (req, res) => {
  const { email, newPassword } = req.body;
  if (!email || !newPassword) return res.status(400).json({ error: 'Email and newPassword required' });
  
  try {
    const check = await pool.query('SELECT id, name FROM users WHERE email = $1', [email]);
    if (check.rows.length === 0) return res.status(404).json({ error: 'No account found with this email.' });
    
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password = $1, reset_otp = NULL, reset_otp_expires_at = NULL WHERE email = $2', [hashedPassword, email]);
    
    res.json({ message: `Password reset successfully for ${check.rows[0].name} (${email}). You can now log in.` });
  } catch (err) {
    console.error('Admin reset error:', err);
    res.status(500).json({ error: 'Failed to reset password.' });
  }
});

export default router;

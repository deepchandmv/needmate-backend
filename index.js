import dotenv from 'dotenv';

// Load .env file for local development.
// On Vercel, env vars are injected by the platform — this is a no-op.
dotenv.config();

import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';

import authRoutes from './routes/auth.js';
import needsRoutes from './routes/needs.js';
import messagesRoutes from './routes/messages.js';

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Root route — so visiting / doesn't hang
app.get('/', (req, res) => {
  res.json({ message: 'NeedMate Backend API', status: 'running', time: new Date() });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date() });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/needs', needsRoutes);
app.use('/api/messages', messagesRoutes);

// 404 catch-all — so unmatched routes always get a response
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

// Initialize DB tables on first load
let dbInitialized = false;
const ensureDb = async () => {
  if (dbInitialized) return;
  // Skip DB init if DATABASE_URL is not set (prevents 10s hang on Vercel)
  if (!process.env.DATABASE_URL) {
    console.warn('DATABASE_URL not set — skipping DB init');
    return;
  }
  try {
    await initDb();
    dbInitialized = true;
  } catch (err) {
    console.error('DB init error:', err.message);
  }
};

// Named exports for api/index.js (Vercel serverless handler)
export { app, ensureDb };

// Only start the local dev server when NOT on Vercel
if (!process.env.VERCEL) {
  const port = process.env.PORT || 3000;
  initDb().then(() => {
    app.listen(port, () => {
      console.log(`Backend server running on port ${port}`);
    });
  }).catch(err => {
    console.error('Failed to init DB on startup', err);
  });
}

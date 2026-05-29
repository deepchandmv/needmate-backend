import dotenv from 'dotenv';
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

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/needs', needsRoutes);
app.use('/api/messages', messagesRoutes);

// Test DB Route
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date() });
});

// Initialize DB tables on first load
let dbInitialized = false;
const ensureDb = async () => {
  if (!dbInitialized) {
    await initDb();
    dbInitialized = true;
  }
};

// Export the app for Vercel serverless (used by api/index.js)
export { app, ensureDb };

// Only start the server when running directly (not imported by Vercel)
const port = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
  initDb().then(() => {
    app.listen(port, () => {
      console.log(`Backend server running on port ${port}`);
    });
  }).catch(err => {
      console.error('Failed to init DB on startup', err);
  });
}

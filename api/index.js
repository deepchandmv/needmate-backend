import { app, ensureDb } from '../index.js';

// Vercel serverless handler — must be a default-exported function
export default async function handler(req, res) {
  await ensureDb();
  app(req, res);
}

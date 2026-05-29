import express from 'express';
import pool from '../db.js';
import { authenticateUser } from './auth.js';

const router = express.Router();

// GET /api/messages/unread-count — must be before /:needId to avoid route conflict
router.get('/unread-count', authenticateUser, async (req, res) => {
  const userId = Number(req.user.userId);
  try {
    const result = await pool.query(
      `SELECT COUNT(*) as count FROM messages WHERE receiver_id = $1 AND is_read = 0`,
      [userId]
    );
    res.json({ count: result.rows[0]?.count || 0 });
  } catch (err) {
    console.error('Unread count error:', err);
    res.status(500).json({ error: 'Failed to get unread count' });
  }
});

// GET /api/messages/:needId
router.get('/:needId', authenticateUser, async (req, res) => {
  const { needId } = req.params;
  const userId = Number(req.user.userId);

  try {
    const check = await pool.query('SELECT created_by, assigned_to FROM needs WHERE id = $1', [needId]);
    if (check.rows.length === 0) return res.status(404).json({ error: 'Need not found' });
    
    const need = check.rows[0];
    const createdBy = Number(need.created_by);
    const assignedTo = need.assigned_to ? Number(need.assigned_to) : null;

    if (createdBy !== userId && assignedTo !== userId) {
        return res.status(403).json({ error: 'Unauthorized to view these messages' });
    }

    const isSelfAssigned = createdBy === assignedTo;
    const otherUserId = isSelfAssigned ? userId : (createdBy === userId ? assignedTo : createdBy);

    // Real-world logic: Only fetch messages between the specific pairs to prevent history leakage if a task is re-assigned
    let messages = { rows: [] };
    if (otherUserId) {
      messages = await pool.query(
        `SELECT m.*, u.name as sender_name 
         FROM messages m
         JOIN users u ON m.sender_id = u.id
         WHERE m.need_id = $1 
         AND ((m.sender_id = $2 AND m.receiver_id = $3) OR (m.sender_id = $4 AND m.receiver_id = $5))
         ORDER BY m.timestamp ASC`,
        [needId, userId, otherUserId, otherUserId, userId]
      );

      // Mark messages as read for current user
      await pool.query(
        `UPDATE messages SET is_read = 1 WHERE need_id = $1 AND receiver_id = $2 AND is_read = 0`,
        [needId, userId]
      );
    }

    res.json(messages.rows);
  } catch (err) {
    console.error('Fetch messages error:', err);
    res.status(500).json({ error: 'Server error fetching messages' });
  }
});

// POST /api/messages
router.post('/', authenticateUser, async (req, res) => {
  const { needId, message } = req.body;
  const userId = Number(req.user.userId);

  if (!needId || !message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Valid needId and message are required' });
  }

  try {
    const check = await pool.query('SELECT created_by, assigned_to FROM needs WHERE id = $1', [needId]);
    if (check.rows.length === 0) return res.status(404).json({ error: 'Need not found' });

    const need = check.rows[0];
    const createdBy = Number(need.created_by);
    const assignedTo = need.assigned_to ? Number(need.assigned_to) : null;

    if (createdBy !== userId && assignedTo !== userId) {
      return res.status(403).json({ error: 'Unauthorized to send messages for this need' });
    }

    const isSelfAssigned = createdBy === assignedTo;
    const receiverId = isSelfAssigned ? userId : (createdBy === userId ? assignedTo : createdBy);
    
    if (!receiverId) {
       return res.status(400).json({ error: 'Cannot send message before need is assigned' });
    }

    const result = await pool.query(
      `INSERT INTO messages (sender_id, receiver_id, need_id, message)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [userId, receiverId, needId, message.trim()]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Post message error:', err);
    res.status(500).json({ error: 'Server error sending message' });
  }
});

export default router;

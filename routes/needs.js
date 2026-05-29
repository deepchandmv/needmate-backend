import express from 'express';
import pool from '../db.js';
import { authenticateUser } from './auth.js';

const router = express.Router();

// Get user's engagements
router.get('/my', authenticateUser, async (req, res) => {
  const userId = req.user.userId;
  try {
    const result = await pool.query(
      `SELECT n.*, 
              uc.name as created_by_name, uc.email as created_by_email, uc.student_class as created_by_class, uc.rating_sum as creator_rating_sum, uc.rating_count as creator_rating_count,
              ua.name as assigned_to_name, ua.email as assigned_to_email, ua.student_class as assigned_to_class, ua.rating_sum as assignee_rating_sum, ua.rating_count as assignee_rating_count
       FROM needs n
       JOIN users uc ON n.created_by = uc.id
       LEFT JOIN users ua ON n.assigned_to = ua.id
       WHERE n.created_by = $1 OR n.assigned_to = $2
       ORDER BY n.created_at DESC`,
      [userId, userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Fetch my needs error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get all needs (potentially filter by category)
router.get('/', async (req, res) => {
  const { category } = req.query;
  try {
    let query = `
      SELECT n.*, 
             uc.name as created_by_name, uc.email as created_by_email, uc.student_class as created_by_class, uc.rating_sum as creator_rating_sum, uc.rating_count as creator_rating_count,
             ua.name as assigned_to_name, ua.email as assigned_to_email, ua.student_class as assigned_to_class, ua.rating_sum as assignee_rating_sum, ua.rating_count as assignee_rating_count
      FROM needs n
      JOIN users uc ON n.created_by = uc.id
      LEFT JOIN users ua ON n.assigned_to = ua.id
      ORDER BY n.created_at DESC
    `;
    let values = [];
    
    if (category && category !== 'all') {
      query = `
        SELECT n.*, 
               uc.name as created_by_name, uc.email as created_by_email, uc.student_class as created_by_class, uc.rating_sum as creator_rating_sum, uc.rating_count as creator_rating_count,
               ua.name as assigned_to_name, ua.email as assigned_to_email, ua.student_class as assigned_to_class, ua.rating_sum as assignee_rating_sum, ua.rating_count as assignee_rating_count
        FROM needs n
        JOIN users uc ON n.created_by = uc.id
        LEFT JOIN users ua ON n.assigned_to = ua.id
        WHERE n.category = $1
        ORDER BY n.created_at DESC
      `;
      values = [category.toLowerCase()];
    }

    const result = await pool.query(query, values);
    res.json(result.rows);
  } catch (err) {
    console.error('Fetch needs error:', err);
    res.status(500).json({ error: 'Server error fetching needs' });
  }
});

// Create a new need
router.post('/', authenticateUser, async (req, res) => {
  const { title, description, category, reward, deadline } = req.body;
  const userId = req.user.userId;

  if (!title || !description || !category || reward === undefined) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO needs (title, description, category, reward, created_by, deadline)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [title, description, category, Number(reward), userId, deadline || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Create need error:', err);
    res.status(500).json({ error: 'Server error creating need' });
  }
});

// Accept a need
router.put('/:id/accept', authenticateUser, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.userId;

  try {
    // Basic checks
    const check = await pool.query('SELECT status, created_by FROM needs WHERE id = $1', [id]);
    if (check.rows.length === 0) return res.status(404).json({ error: 'Need not found' });
    if (check.rows[0].status !== 'open') return res.status(400).json({ error: 'Need is not open' });

    const update = await pool.query(
      `UPDATE needs 
       SET status = 'in-progress', assigned_to = $1 
       WHERE id = $2 RETURNING *`,
      [userId, id]
    );

    res.json(update.rows[0]);
  } catch (err) {
    console.error('Accept need error:', err);
    res.status(500).json({ error: 'Server error accepting need' });
  }
});

// Complete a need
router.put('/:id/complete', authenticateUser, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.userId;

  try {
    const check = await pool.query('SELECT status, created_by, assigned_to FROM needs WHERE id = $1', [id]);
    if (check.rows.length === 0) return res.status(404).json({ error: 'Need not found' });
    
    // Only the creator or assignee can mark as complete
    const need = check.rows[0];
    if (need.created_by !== userId && need.assigned_to !== userId) {
      return res.status(403).json({ error: 'Unauthorized to complete this need' });
    }

    const update = await pool.query(
      `UPDATE needs SET status = 'completed' WHERE id = $1 RETURNING *`,
      [id]
    );

    res.json(update.rows[0]);
  } catch (err) {
    console.error('Complete need error:', err);
    res.status(500).json({ error: 'Server error completing need' });
  }
});

// Delete a need
router.delete('/:id', authenticateUser, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.userId;

  try {
    const check = await pool.query('SELECT created_by FROM needs WHERE id = $1', [id]);
    if (check.rows.length === 0) return res.status(404).json({ error: 'Need not found' });
    
    // Only the creator can delete it
    if (check.rows[0].created_by !== userId) {
      return res.status(403).json({ error: 'Unauthorized to delete this need' });
    }

    await pool.query('DELETE FROM needs WHERE id = $1', [id]);
    res.json({ message: 'Need deleted successfully' });
  } catch (err) {
    console.error('Delete need error:', err);
    res.status(500).json({ error: 'Server error deleting need' });
  }
});

// Decline an assigned need
router.put('/:id/decline', authenticateUser, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.userId;

  try {
    const check = await pool.query('SELECT status, assigned_to FROM needs WHERE id = $1', [id]);
    if (check.rows.length === 0) return res.status(404).json({ error: 'Need not found' });
    
    if (check.rows[0].assigned_to !== userId) {
      return res.status(403).json({ error: 'Unauthorized to decline this need' });
    }

    const update = await pool.query(
      `UPDATE needs SET status = 'open', assigned_to = NULL WHERE id = $1 RETURNING *`,
      [id]
    );

    res.json(update.rows[0]);
  } catch (err) {
    console.error('Decline need error:', err);
    res.status(500).json({ error: 'Server error declining need' });
  }
});

// Rate a user
router.post('/:id/rate', authenticateUser, async (req, res) => {
  const { id } = req.params;
  const { rating } = req.body;
  const userId = req.user.userId;
  
  if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Invalid rating' });

  try {
    const check = await pool.query('SELECT status, created_by, assigned_to, rated_by_creator, rated_by_assignee FROM needs WHERE id = $1', [id]);
    if (check.rows.length === 0) return res.status(404).json({ error: 'Need not found' });
    
    const need = check.rows[0];
    if (need.status !== 'completed') return res.status(400).json({ error: 'Can only rate completed needs' });
    
    let targetUserId = null;
    let ratingColumn = null;
    if (need.created_by === userId) {
      targetUserId = need.assigned_to;
      ratingColumn = 'rated_by_creator';
      if (need.rated_by_creator) return res.status(400).json({ error: 'You have already rated this task.' });
    } else if (need.assigned_to === userId) {
      targetUserId = need.created_by;
      ratingColumn = 'rated_by_assignee';
      if (need.rated_by_assignee) return res.status(400).json({ error: 'You have already rated this task.' });
    } else {
      return res.status(403).json({ error: 'You are not part of this engagement' });
    }

    if (!targetUserId) return res.status(400).json({ error: 'No user to rate' });

    await pool.query(
      `UPDATE users SET rating_sum = rating_sum + $1, rating_count = rating_count + 1 WHERE id = $2`,
      [Number(rating), targetUserId]
    );

    // Store the rating on the need so we can display it later
    await pool.query(
      `UPDATE needs SET ${ratingColumn} = $1 WHERE id = $2`,
      [Number(rating), id]
    );

    res.json({ message: 'Rating submitted successfully', rating: Number(rating) });
  } catch (err) {
    console.error('Rate error:', err);
    res.status(500).json({ error: 'Server error parsing rating' });
  }
});

export default router;

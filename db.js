import pg from 'pg';

const { Pool } = pg;

// Lazy pool initialization — pool is created on first use,
// after dotenv has loaded environment variables in index.js.
// This avoids the ES module hoisting issue where db.js evaluates
// before dotenv.config() runs in index.js.
let pool = null;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
  }
  return pool;
}

export const initDb = async () => {
  const db = getPool();
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        student_class TEXT,
        is_verified INTEGER DEFAULT 0,
        rating_sum NUMERIC DEFAULT 0,
        rating_count INTEGER DEFAULT 0,
        reset_otp TEXT,
        reset_otp_expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Add columns if they don't exist (idempotent migration)
    const addColumnIfNotExists = async (table, column, type) => {
      try {
        await db.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${type}`);
      } catch (e) { /* ignore */ }
    };

    await addColumnIfNotExists('users', 'reset_otp', 'TEXT');
    await addColumnIfNotExists('users', 'reset_otp_expires_at', 'TIMESTAMPTZ');
    await addColumnIfNotExists('users', 'student_class', 'TEXT');
    await addColumnIfNotExists('users', 'is_verified', 'INTEGER DEFAULT 0');

    await db.query(`
      CREATE TABLE IF NOT EXISTS needs (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        category TEXT NOT NULL,
        reward NUMERIC NOT NULL,
        status TEXT DEFAULT 'open',
        created_by INTEGER REFERENCES users(id) ON DELETE CASCADE,
        assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
        rated_by_creator INTEGER,
        rated_by_assignee INTEGER,
        deadline TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        sender_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        receiver_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        need_id INTEGER REFERENCES needs(id) ON DELETE CASCADE,
        message TEXT NOT NULL,
        is_read INTEGER DEFAULT 0,
        timestamp TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS pending_registrations (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        student_class TEXT,
        otp TEXT NOT NULL,
        otp_expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await addColumnIfNotExists('needs', 'rated_by_creator', 'INTEGER');
    await addColumnIfNotExists('needs', 'rated_by_assignee', 'INTEGER');
    await addColumnIfNotExists('messages', 'is_read', 'INTEGER DEFAULT 0');

    console.log('Database tables initialized successfully using Postgres.');
  } catch (err) {
    console.error('Error initializing database tables:', err);
  }
};

// Export a proxy that lazily creates the pool
// Routes import `pool` and call pool.query() — this ensures
// the pool is created after dotenv.config() has run.
export default {
  query: (...args) => getPool().query(...args),
  connect: (...args) => getPool().connect(...args),
  end: (...args) => getPool().end(...args),
};
// Shared Postgres access for all API routes.
// Works with any standard Postgres connection string (Neon, Vercel Postgres,
// Supabase, etc.) supplied as DATABASE_URL. Creates the schema on first use,
// so a brand-new empty database just works — no separate migration step.
const { Pool } = require('pg');

let pool;
function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 10000,
    });
  }
  return pool;
}

let schemaReady;
function ensureSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const p = getPool();
    await p.query(`
      CREATE TABLE IF NOT EXISTS users (
        id            text PRIMARY KEY,
        first_name    text NOT NULL,
        email         text UNIQUE NOT NULL,
        password_hash text NOT NULL,
        plan          text NOT NULL DEFAULT 'free',
        free_clips_used int NOT NULL DEFAULT 0,
        paused        boolean NOT NULL DEFAULT false,
        daily_pace    int NOT NULL DEFAULT 3,
        rules         text NOT NULL DEFAULT '',
        stripe_customer_id text,
        created_at    timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token      text PRIMARY KEY,
        user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
      CREATE TABLE IF NOT EXISTS channel_settings (
        user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        platform     text NOT NULL,
        shorts_length text NOT NULL DEFAULT 'auto',
        medium_form  boolean NOT NULL DEFAULT false,
        PRIMARY KEY (user_id, platform)
      );
      CREATE TABLE IF NOT EXISTS messages (
        id         bigserial PRIMARY KEY,
        user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role       text NOT NULL,
        text       text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS messages_user_idx ON messages(user_id);
      CREATE TABLE IF NOT EXISTS jobs (
        id         bigserial PRIMARY KEY,
        user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type       text NOT NULL,
        payload    jsonb NOT NULL DEFAULT '{}',
        status     text NOT NULL DEFAULT 'queued',
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS jobs_user_idx ON jobs(user_id, status);
      CREATE TABLE IF NOT EXISTS clips (
        id           bigserial PRIMARY KEY,
        user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source_title text NOT NULL,
        platform     text,
        status       text NOT NULL DEFAULT 'banked',
        created_at   timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS clips_user_idx ON clips(user_id);
    `);
  })().catch((e) => { schemaReady = null; throw e; });
  return schemaReady;
}

async function q(text, params) {
  await ensureSchema();
  return getPool().query(text, params);
}

function configured() {
  return !!process.env.DATABASE_URL;
}

module.exports = { getPool, ensureSchema, q, configured };

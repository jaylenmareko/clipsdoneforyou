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
      ALTER TABLE jobs  ADD COLUMN IF NOT EXISTS priority int NOT NULL DEFAULT 0;
      ALTER TABLE jobs  ADD COLUMN IF NOT EXISTS channel text;
      ALTER TABLE clips ADD COLUMN IF NOT EXISTS url text;
      ALTER TABLE clips ADD COLUMN IF NOT EXISTS posted_at timestamptz;
      -- per-clip editable fields (the clip's own title/description, set by the
      -- engine and editable from the Clips tab) + duration in seconds.
      ALTER TABLE clips ADD COLUMN IF NOT EXISTS title text;
      ALTER TABLE clips ADD COLUMN IF NOT EXISTS description text;
      ALTER TABLE clips ADD COLUMN IF NOT EXISTS duration int;
      -- a preview image the engine renders for the clip (a frame, or the source
      -- video's thumbnail) so every card shows a real preview, not a placeholder.
      ALTER TABLE clips ADD COLUMN IF NOT EXISTS thumbnail_url text;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS journey jsonb NOT NULL DEFAULT '{}'::jsonb;
      -- per-channel conversations: every message belongs to one conversation
      -- ('all' = All channels, or 'platform:handle' = a channel). Existing rows
      -- migrate to 'all' via the default.
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS conversation text NOT NULL DEFAULT 'all';
      CREATE INDEX IF NOT EXISTS messages_conv_idx ON messages(user_id, conversation, id);
      -- per-channel settings + the connected handle (so conversations/routing
      -- survive a disconnect). NULL pace/paused fall back to the account.
      ALTER TABLE channel_settings ADD COLUMN IF NOT EXISTS rules text NOT NULL DEFAULT '';
      ALTER TABLE channel_settings ADD COLUMN IF NOT EXISTS daily_pace int;
      ALTER TABLE channel_settings ADD COLUMN IF NOT EXISTS paused boolean;
      ALTER TABLE channel_settings ADD COLUMN IF NOT EXISTS handle text;
    `);
  })().catch((e) => { schemaReady = null; throw e; });
  return schemaReady;
}

async function q(text, params) {
  // Boundary: the SITE never creates clips. Only the external engine writes
  // clips rows (and a 'posted' row only ever exists behind a real upload). The
  // site reads clips, and may UPDATE/DELETE a user's own clips (queue, retitle,
  // remove) — but it must never INSERT one. Blocked at the data layer so no
  // route, script, or future mistake can seed fake/demo clips for any user.
  if (/insert\s+into\s+clips\b/i.test(text)) {
    throw new Error('blocked: the site never inserts into clips — only the engine writes clips rows');
  }
  await ensureSchema();
  return getPool().query(text, params);
}

function configured() {
  return !!process.env.DATABASE_URL;
}

module.exports = { getPool, ensureSchema, q, configured };

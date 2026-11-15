// Session + cookie helpers. Sessions are opaque random tokens stored in the
// DB and sent to the browser as an httpOnly cookie, so the session survives
// refresh and can't be read by JS. Logout deletes the row.
const crypto = require('crypto');
const { q } = require('./_db');

const COOKIE = 'cdfy_session';
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

function parseCookies(req) {
  const out = {};
  const raw = req.headers && req.headers.cookie;
  if (!raw) return out;
  raw.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie',
    `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${MAX_AGE}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie',
    `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + MAX_AGE * 1000);
  await q('INSERT INTO sessions(token, user_id, expires_at) VALUES ($1,$2,$3)',
    [token, userId, expires]);
  return token;
}

// Returns the full user row for the current session, or null.
async function getUser(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const r = await q(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = $1 AND s.expires_at > now()`, [token]);
  return r.rows[0] || null;
}

async function destroySession(req) {
  const token = parseCookies(req)[COOKIE];
  if (token) await q('DELETE FROM sessions WHERE token = $1', [token]);
}

module.exports = {
  COOKIE, parseCookies, setSessionCookie, clearSessionCookie,
  createSession, getUser, destroySession,
};

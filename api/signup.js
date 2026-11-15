// POST /api/signup  { firstName, email, password }
// Creates a real account (password hashed with bcrypt, never stored plaintext),
// opens a session, and sets the httpOnly cookie. The user id doubles as the
// stable Upload-Post profile username used by /api/connect.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { q, configured } = require('./_db');
const { createSession, setSessionCookie } = require('./_auth');

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  if (!configured()) { res.status(501).json({ error: 'not_configured' }); return; }

  const { firstName, email, password } = req.body || {};
  const first = typeof firstName === 'string' ? firstName.trim() : '';
  const em = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!first || !EMAIL_RE.test(em) || typeof password !== 'string' || password.length < 6) {
    res.status(400).json({ error: 'bad_request' }); return;
  }

  try {
    const exists = await q('SELECT 1 FROM users WHERE email = $1', [em]);
    if (exists.rows.length) { res.status(409).json({ error: 'email_taken' }); return; }

    const id = 'u_' + crypto.randomBytes(9).toString('hex');
    const hash = await bcrypt.hash(password, 10);
    await q('INSERT INTO users(id, first_name, email, password_hash) VALUES ($1,$2,$3,$4)',
      [id, first.slice(0, 80), em, hash]);

    const token = await createSession(id);
    setSessionCookie(res, token);
    res.status(200).json({ ok: true, user: { id, firstName: first, email: em, plan: 'free' } });
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
};

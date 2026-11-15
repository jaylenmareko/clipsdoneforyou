// POST /api/login  { email, password }
// Validates credentials and opens a session. Wrong email or password → 401.
const bcrypt = require('bcryptjs');
const { q, configured } = require('./_db');
const { createSession, setSessionCookie } = require('./_auth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  if (!configured()) { res.status(501).json({ error: 'not_configured' }); return; }

  const { email, password } = req.body || {};
  const em = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!em || typeof password !== 'string' || !password) {
    res.status(400).json({ error: 'bad_request' }); return;
  }

  try {
    const r = await q('SELECT * FROM users WHERE email = $1', [em]);
    const user = r.rows[0];
    if (!user) { res.status(401).json({ error: 'invalid_credentials' }); return; }
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) { res.status(401).json({ error: 'invalid_credentials' }); return; }

    const token = await createSession(user.id);
    setSessionCookie(res, token);
    res.status(200).json({ ok: true, user: { id: user.id, firstName: user.first_name, email: user.email, plan: user.plan } });
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
};

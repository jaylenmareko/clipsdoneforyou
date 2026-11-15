// POST /api/logout — ends the current session for real and clears the cookie.
const { configured } = require('./_db');
const { destroySession, clearSessionCookie } = require('./_auth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  try {
    if (configured()) await destroySession(req);
  } catch (e) { /* clearing the cookie below still logs them out */ }
  clearSessionCookie(res);
  res.status(200).json({ ok: true });
};

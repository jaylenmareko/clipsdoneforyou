// POST /api/disconnect
// Removes the signed-in user's connected channels by deleting their provider
// profile (Upload-Post has no per-platform disconnect). Scoped to the session
// user — the account id is taken from the cookie, never the body, so no one can
// remove someone else's connections. Frees the profile slot for reuse.
const provider = require('./_provider');
const { configured } = require('./_db');
const { getUser } = require('./_auth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  if (!provider.configured() || !configured()) { res.status(501).json({ error: 'not_configured' }); return; }

  try {
    const u = await getUser(req);
    if (!u) { res.status(401).json({ error: 'unauthorized' }); return; }

    const r = await provider.disconnect(u.id);
    if (r.ok) { res.status(200).json({ ok: true }); return; }
    res.status(502).json({ error: r.error || 'disconnect_failed' });
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
};

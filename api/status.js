// GET /api/status?username=<profile>
// Returns which platforms are actually connected on the user's profile, with
// handles — the connect card and gate render from this. Provider specifics
// live in _provider.js (the swap boundary); this route only maps to HTTP.
const provider = require('./_provider');

module.exports = async (req, res) => {
  if (!provider.configured()) { res.status(501).json({ error: 'not_configured' }); return; }
  const username = (req.query && req.query.username) || '';
  if (!username) { res.status(400).json({ error: 'bad_request' }); return; }

  const r = await provider.getStatus(username);
  if (r.connected) { res.status(200).json({ username, connected: r.connected }); return; }
  if (r.error === 'no_profile') { res.status(404).json({ error: 'no_profile' }); return; }
  res.status(502).json({ error: r.error || 'upstream' });
};

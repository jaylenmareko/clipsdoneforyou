// POST /api/connect  { username, platform }
// Starts a real OAuth connection for one platform and returns the platform's
// authorize_url for the browser to redirect to. Provider specifics live in
// _provider.js (the swap boundary) — this route only maps results to HTTP.
const provider = require('./_provider');

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  if (!provider.configured()) { res.status(501).json({ error: 'not_configured' }); return; }

  const { username, platform } = req.body || {};
  if (!username || typeof username !== 'string' || !provider.PLATFORMS.includes(platform)) {
    res.status(400).json({ error: 'bad_request' }); return;
  }

  const r = await provider.startConnect(username, platform);
  if (r.authorize_url) { res.status(200).json({ authorize_url: r.authorize_url }); return; }
  if (r.error === 'profile_limit') { res.status(409).json({ error: 'profile_limit' }); return; }
  if (r.error === 'start_failed') { res.status(502).json({ error: 'start_failed', detail: r.detail || null }); return; }
  res.status(502).json({ error: r.error || 'connect_failed' });
};

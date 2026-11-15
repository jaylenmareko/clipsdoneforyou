// GET /api/status?username=<profile>
// Returns which platforms are actually connected on the user's
// Upload-Post profile, with handles — the connect card renders from this.
const API = 'https://api.upload-post.com';

module.exports = async (req, res) => {
  const key = process.env.UPLOAD_POST_API_KEY;
  if (!key) { res.status(501).json({ error: 'not_configured' }); return; }
  const username = (req.query && req.query.username) || '';
  if (!username) { res.status(400).json({ error: 'bad_request' }); return; }

  const r = await fetch(API + '/api/uploadposts/users', {
    headers: { 'Authorization': 'Apikey ' + key, 'User-Agent': 'clipsdoneforyou-site/1.0' },
  });
  if (r.status !== 200) { res.status(502).json({ error: 'upstream' }); return; }
  const users = await r.json();
  const list = Array.isArray(users) ? users : (users.users || []);
  const profile = list.find((u) => u.username === username);
  if (!profile) { res.status(404).json({ error: 'no_profile' }); return; }

  const connected = {};
  for (const [platform, v] of Object.entries(profile.social_accounts || {})) {
    connected[platform] = v
      ? { handle: v.handle || null, name: v.display_name || null, reauth: !!v.reauth_required }
      : null;
  }
  res.status(200).json({ username, connected });
};

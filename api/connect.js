// POST /api/connect  { username, platform }
// Starts a real Upload-Post OAuth connection for one platform:
// ensures the user's profile exists, mints a profile JWT, and returns
// the platform's authorize_url for the browser to redirect to.
const API = 'https://api.upload-post.com';
const REDIRECT = 'https://www.clipsdoneforyou.com/?connect_return=1';

async function up(method, path, opts) {
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'clipsdoneforyou-site/1.0' };
  headers['Authorization'] = opts.bearer ? 'Bearer ' + opts.bearer : 'Apikey ' + opts.key;
  const r = await fetch(API + path, {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = {};
  try { data = await r.json(); } catch (e) { /* non-JSON */ }
  return { status: r.status, data };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  const key = process.env.UPLOAD_POST_API_KEY;
  if (!key) { res.status(501).json({ error: 'not_configured' }); return; }

  const { username, platform } = req.body || {};
  const allowed = ['youtube', 'tiktok', 'instagram', 'facebook', 'linkedin', 'x'];
  if (!username || typeof username !== 'string' || !allowed.includes(platform)) {
    res.status(400).json({ error: 'bad_request' }); return;
  }

  // Ensure the profile exists (403 = plan profile limit reached).
  const created = await up('POST', '/api/uploadposts/users', { key, body: { username } });
  if (created.status === 403) { res.status(409).json({ error: 'profile_limit' }); return; }

  // Mint the profile JWT (comes back inside access_url as ?token=...).
  const jwt = await up('POST', '/api/uploadposts/users/generate-jwt', {
    key, body: { username, redirect_url: REDIRECT },
  });
  if (jwt.status !== 200 || !jwt.data.access_url) {
    res.status(502).json({ error: 'jwt_failed' }); return;
  }
  const token = new URL(jwt.data.access_url).searchParams.get('token');
  if (!token) { res.status(502).json({ error: 'jwt_failed' }); return; }

  // Ask Upload-Post for the platform's real OAuth authorize URL.
  const start = await up('POST', '/api/uploadposts/oauth/' + platform + '/start', {
    bearer: token, body: { redirect_url: REDIRECT },
  });
  if (start.status !== 200 || !start.data.authorize_url) {
    res.status(502).json({ error: 'start_failed', detail: start.data.error_code || null }); return;
  }
  res.status(200).json({ authorize_url: start.data.authorize_url });
};

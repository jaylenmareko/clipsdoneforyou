// ---------------------------------------------------------------------------
// Posting-provider abstraction (the swap boundary).
//
// Every Upload-Post-specific detail — base URL, auth header, endpoint paths,
// the profile/JWT/OAuth dance, the status shape — lives in THIS file and
// nowhere else. The rest of the app (client, DB, other /api routes) only knows
// the neutral operations below. To move off Upload-Post (direct YouTube/Meta/
// TikTok integrations, or another aggregator), reimplement these functions
// against the new backend and nothing else changes.
//
// Neutral interface:
//   configured()                      -> boolean
//   PLATFORMS                         -> string[]
//   startConnect(username, platform)  -> { authorize_url } | { error }
//   getStatus(username)               -> { connected } | { error }
//   disconnect(username, platform)    -> { error:'not_supported' }  (see note)
//
// NOTE: Upload-Post's public API does not document a disconnect-social-account
// or delete-profile endpoint (confirmed against their llm.txt / llms-full.txt),
// even though the dashboard UI can do it. Until that endpoint is confirmed with
// Upload-Post, disconnect() returns not_supported so callers can message it
// honestly rather than guess an undocumented route.
// ---------------------------------------------------------------------------

const API = 'https://api.upload-post.com';
const RETURN_URL = 'https://www.clipsdoneforyou.com/?connect_return=1';
const PLATFORMS = ['youtube', 'tiktok', 'instagram', 'facebook', 'linkedin', 'x'];

function configured() { return !!process.env.UPLOAD_POST_API_KEY; }

async function up(method, path, opts) {
  opts = opts || {};
  const key = process.env.UPLOAD_POST_API_KEY;
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'clipsdoneforyou-site/1.0' };
  headers['Authorization'] = opts.bearer ? 'Bearer ' + opts.bearer : 'Apikey ' + key;
  const r = await fetch(API + path, {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = {};
  try { data = await r.json(); } catch (e) { /* non-JSON */ }
  return { status: r.status, data };
}

// Start one platform's real OAuth connection for a user's profile.
async function startConnect(username, platform) {
  // Ensure the profile exists (403 = plan profile limit reached).
  const created = await up('POST', '/api/uploadposts/users', { body: { username } });
  if (created.status === 403) return { error: 'profile_limit' };

  // Mint the profile JWT (comes back inside access_url as ?token=...).
  const jwt = await up('POST', '/api/uploadposts/users/generate-jwt', {
    body: { username, redirect_url: RETURN_URL },
  });
  if (jwt.status !== 200 || !jwt.data.access_url) return { error: 'jwt_failed' };
  let token = null;
  try { token = new URL(jwt.data.access_url).searchParams.get('token'); } catch (e) { /* bad url */ }
  if (!token) return { error: 'jwt_failed' };

  // Ask for the platform's real OAuth authorize URL.
  const start = await up('POST', '/api/uploadposts/oauth/' + platform + '/start', {
    bearer: token, body: { redirect_url: RETURN_URL },
  });
  if (start.status !== 200 || !start.data.authorize_url) {
    return { error: 'start_failed', detail: (start.data && start.data.error_code) || null };
  }
  return { authorize_url: start.data.authorize_url };
}

// Which platforms are actually connected on a user's profile, with handles.
async function getStatus(username) {
  const r = await up('GET', '/api/uploadposts/users');
  if (r.status !== 200) return { error: 'upstream' };
  const users = r.data;
  const list = Array.isArray(users) ? users : (users.profiles || users.users || []);
  const profile = list.find((u) => u.username === username);
  if (!profile) return { error: 'no_profile' };
  const connected = {};
  for (const [platform, v] of Object.entries(profile.social_accounts || {})) {
    connected[platform] = v
      ? { handle: v.handle || null, name: v.display_name || null, reauth: !!v.reauth_required }
      : null;
  }
  return { connected };
}

// Remove a user's connections. Upload-Post only supports deleting the WHOLE
// profile (DELETE /api/uploadposts/users {username}) — there is no per-platform
// disconnect — so this removes every connected channel for the account and
// frees the profile slot. 404 (already gone) counts as success.
async function disconnect(username) {
  const r = await up('DELETE', '/api/uploadposts/users', { body: { username } });
  if (r.status === 200 || r.status === 204 || r.status === 404) return { ok: true };
  return { error: 'upstream', status: r.status };
}

module.exports = { configured, PLATFORMS, startConnect, getStatus, disconnect };

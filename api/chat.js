// POST /api/chat  { text }
// The agent that actually does things. Messages persist per user. It applies
// what it can (pace, pause/resume, per-channel length, standing rules), reports
// real status from the database, and records "clip this video <link>" as a job
// in the queue the external engine consumes. It never simulates a post or
// invents a clip — if it can't action something, it says so plainly.
const { q, configured } = require('./_db');
const { getUser } = require('./_auth');

const PLATFORMS = ['youtube', 'tiktok', 'instagram', 'facebook', 'linkedin', 'x'];
const UP_API = 'https://api.upload-post.com';

function detectPlatform(t) {
  if (/tiktok/.test(t)) return 'tiktok';
  if (/insta|ig\b/.test(t)) return 'instagram';
  if (/youtube|yt\b|shorts/.test(t)) return 'youtube';
  if (/facebook|fb\b/.test(t)) return 'facebook';
  if (/linkedin/.test(t)) return 'linkedin';
  if (/(^|\s)x(\s|$)|twitter/.test(t)) return 'x';
  return null;
}
function lengthFromText(t) {
  if (/under\s*30|<\s*30|shorter|short/.test(t)) return 'under30';
  if (/30\s*[-to]+\s*60/.test(t)) return '30-60';
  if (/60\s*[-to]+\s*90/.test(t)) return '60-90';
  if (/90\s*[-to]+\s*180|longer|long/.test(t)) return '90-180';
  return null;
}
const LENGTH_LABEL = { auto: 'auto (30–105s)', under30: 'under 30s', '30-60': '30–60s', '60-90': '60–90s', '90-180': '90–180s' };

async function connectedCount(username) {
  const key = process.env.UPLOAD_POST_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch(UP_API + '/api/uploadposts/users', {
      headers: { Authorization: 'Apikey ' + key, 'User-Agent': 'clipsdoneforyou-site/1.0' },
    });
    if (r.status !== 200) return null;
    const users = await r.json();
    const list = Array.isArray(users) ? users : (users.profiles || users.users || []);
    const profile = list.find((p) => p.username === username);
    if (!profile) return 0;
    return Object.values(profile.social_accounts || {}).filter(Boolean).length;
  } catch (e) { return null; }
}

async function handle(user, text) {
  const t = text.toLowerCase();
  const changed = {};

  // 1. clip request — any URL → queue a job (engine consumes it).
  const url = (text.match(/https?:\/\/\S+/) || [])[0];
  if (url && /\bclip\b/.test(t)) {
    await q('INSERT INTO jobs(user_id, type, payload) VALUES ($1,$2,$3)',
      [user.id, 'clip_request', JSON.stringify({ url })]);
    return { reply: "Queued. I'll pull the best moments from that video and post them to your connected channels — they'll show up under Clips as they're made.", changed };
  }
  if (url) {
    await q('INSERT INTO jobs(user_id, type, payload) VALUES ($1,$2,$3)',
      [user.id, 'clip_request', JSON.stringify({ url })]);
    return { reply: "Got the link — queued it for clipping. The best moments will post to your connected channels and land under Clips.", changed };
  }

  // 2. pause / resume
  if (/\b(pause|stop posting|hold posting)\b/.test(t)) {
    await q('UPDATE users SET paused = true WHERE id = $1', [user.id]);
    changed.paused = true;
    return { reply: "Posting is paused. Your clips keep banking — say “resume” whenever you want them going out again.", changed };
  }
  if (/\b(resume|unpause|start posting|keep posting)\b/.test(t)) {
    await q('UPDATE users SET paused = false WHERE id = $1', [user.id]);
    changed.paused = false;
    return { reply: "Posting resumed. Banked clips will start going out again.", changed };
  }

  // 3. daily pace
  const paceM = t.match(/(\d+)\s*(?:clips?\s*)?(?:a|per)\s*day/) || t.match(/post\s*(\d+)\s*(?:a|per)?\s*day/);
  if (paceM && /\b(post|pace|clip|day)\b/.test(t)) {
    const n = Math.max(1, Math.min(24, parseInt(paceM[1], 10)));
    await q('UPDATE users SET daily_pace = $1 WHERE id = $2', [n, user.id]);
    changed.dailyPace = n;
    return { reply: `Done — pacing to ${n} ${n === 1 ? 'clip' : 'clips'} a day.`, changed };
  }

  // 4. per-channel length
  const len = lengthFromText(t);
  if (len && /(length|clip|short|make|set|minute|second|\ds)/.test(t)) {
    const platform = detectPlatform(t) || 'youtube';
    await q(
      `INSERT INTO channel_settings(user_id, platform, shorts_length, medium_form)
       VALUES ($1,$2,$3,false)
       ON CONFLICT (user_id, platform) DO UPDATE SET shorts_length = EXCLUDED.shorts_length`,
      [user.id, platform, len]);
    changed.channel = { platform, shortsLength: len };
    return { reply: `Set your ${platform} clips to ${LENGTH_LABEL[len]}.`, changed };
  }

  // 5. standing rule
  if (/^(always|never|don'?t|do not|rule:)/.test(t) || /\brule\b/.test(t)) {
    const rule = text.trim().replace(/^rule:\s*/i, '');
    const cur = user.rules ? user.rules + '\n' : '';
    const next = (cur + '• ' + rule).slice(0, 2000);
    await q('UPDATE users SET rules = $1 WHERE id = $2', [next, user.id]);
    changed.rules = next;
    return { reply: "Saved that as a standing rule. I'll apply it to every clip from now on.", changed };
  }

  // 6. status
  if (/\b(status|how many|what'?s? connected|what is connected|where am i|summary|report)\b/.test(t)) {
    const counts = await q(
      `SELECT count(*) FILTER (WHERE status='posted')::int posted,
              count(*) FILTER (WHERE status='banked')::int banked FROM clips WHERE user_id=$1`, [user.id]);
    const c = counts.rows[0] || { posted: 0, banked: 0 };
    const conn = await connectedCount(user.id);
    const freeLeft = Math.max(0, 10 - user.free_clips_used);
    const parts = [];
    parts.push(conn === null ? 'Channels: check the connect card below.' : `${conn} channel${conn === 1 ? '' : 's'} connected.`);
    parts.push(user.plan === 'free'
      ? `Free plan — ${freeLeft} of 10 free clips left.`
      : `On the ${user.plan} plan.`);
    parts.push(`${c.posted} posted, ${c.banked} banked.`);
    parts.push(user.paused ? 'Posting is paused.' : `Pacing ${user.daily_pace}/day.`);
    return { reply: parts.join(' '), changed };
  }

  // 7. honest fallback
  return {
    reply: "I can change clip length, set your daily pace, pause or resume posting, save a standing rule, give you a status, or queue a video to clip (just paste the link with “clip this”). I couldn't action that one — try one of those.",
    changed,
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  if (!configured()) { res.status(501).json({ error: 'not_configured' }); return; }
  try {
    const user = await getUser(req);
    if (!user) { res.status(401).json({ error: 'unauthorized' }); return; }
    const text = (req.body && typeof req.body.text === 'string') ? req.body.text.trim() : '';
    if (!text) { res.status(400).json({ error: 'bad_request' }); return; }

    await q('INSERT INTO messages(user_id, role, text) VALUES ($1,$2,$3)', [user.id, 'me', text.slice(0, 2000)]);
    const { reply, changed } = await handle(user, text);
    await q('INSERT INTO messages(user_id, role, text) VALUES ($1,$2,$3)', [user.id, 'agent', reply]);

    res.status(200).json({ reply, changed });
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
};

// POST /api/chat  { text, conversation }
// Conversation-aware agent. Instructions in a CHANNEL conversation apply to that
// channel only (written to its channel_settings); instructions in 'all' apply to
// every channel (written to the account). A clip link in a channel conversation
// enqueues the job for that channel; in 'all' it asks which channel (unless one
// is connected). It never fabricates a post — real posts come from the engine.
const { q, configured } = require('./_db');
const { getUser } = require('./_auth');
const { chanKey } = require('./_journey');

const UP_API = 'https://api.upload-post.com';
function lengthFromText(t) {
  if (/under\s*30|<\s*30|shorter|short/.test(t)) return 'under30';
  if (/30\s*[-to]+\s*60/.test(t)) return '30-60';
  if (/60\s*[-to]+\s*90/.test(t)) return '60-90';
  if (/90\s*[-to]+\s*180|longer|long/.test(t)) return '90-180';
  return null;
}
const LENGTH_LABEL = { auto: 'auto (30–105s)', under30: 'under 30s', '30-60': '30–60s', '60-90': '60–90s', '90-180': '90–180s' };

// upsert one column on a channel's settings row
async function setChan(userId, platform, col, val) {
  await q(`INSERT INTO channel_settings(user_id, platform, ${col}) VALUES ($1,$2,$3)
           ON CONFLICT (user_id, platform) DO UPDATE SET ${col} = EXCLUDED.${col}`, [userId, platform, val]);
}

async function connectedCount(username) {
  const key = process.env.UPLOAD_POST_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch(UP_API + '/api/uploadposts/users', { headers: { Authorization: 'Apikey ' + key, 'User-Agent': 'clipsdoneforyou-site/1.0' } });
    if (r.status !== 200) return null;
    const users = await r.json();
    const list = Array.isArray(users) ? users : (users.profiles || users.users || []);
    const profile = list.find((p) => p.username === username);
    if (!profile) return 0;
    return Object.values(profile.social_accounts || {}).filter(Boolean).length;
  } catch (e) { return null; }
}

async function handle(user, text, conv) {
  const t = text.toLowerCase();
  const changed = {};
  const isChannel = conv && conv !== 'all' && conv.indexOf(':') > 0;
  const convPlatform = isChannel ? conv.split(':')[0] : null;
  const scope = isChannel ? 'this channel' : 'every channel';

  // connected channels (platform -> handle) from stored settings
  const chR = await q('SELECT platform, handle FROM channel_settings WHERE user_id=$1 AND handle IS NOT NULL', [user.id]);
  const channels = chR.rows;
  const handleFor = (p) => (channels.find((c) => c.platform === p) || {}).handle || p;

  // ---- clip request (any URL) ----
  const url = (text.match(/https?:\/\/\S+/) || [])[0];
  if (url && user.journey && user.journey.awaitingLinks && !isChannel) {
    await q("INSERT INTO jobs(user_id, type, payload, priority) VALUES ($1,'first_batch',$2,100)", [user.id, JSON.stringify({ source: 'link', url, count: 3 }), ]);
    const j = Object.assign({}, user.journey); j.awaitingLinks = false;
    await q('UPDATE users SET journey=$1 WHERE id=$2', [JSON.stringify(j), user.id]);
    return { reply: "Got it — cutting your first clips from that video now. Your first ones post today. Paste more links anytime.", changed };
  }
  if (url) {
    let platform = convPlatform, targetConv = isChannel ? conv : null;
    if (!isChannel) {
      if (channels.length === 1) { platform = channels[0].platform; targetConv = chanKey(platform, channels[0].handle); }
      else if (channels.length > 1) { return { reply: 'Which channel should I clip that for? ' + channels.map((c) => c.handle).join(', ') + ' — tell me in that channel, or name it here.', changed }; }
    }
    await q("INSERT INTO jobs(user_id, type, payload, channel) VALUES ($1,'clip_request',$2,$3)", [user.id, JSON.stringify({ url, platform }), targetConv]);
    return { reply: 'Queued — I’ll clip that and post it' + (platform ? ' to ' + handleFor(platform) : '') + '. It’ll show up here as it goes live.', changed };
  }

  // ---- pause / resume ----
  if (/\b(pause|stop posting|hold posting)\b/.test(t)) {
    if (isChannel) { await setChan(user.id, convPlatform, 'paused', true); return { reply: 'Paused posting for ' + handleFor(convPlatform) + '. Its clips keep banking.', changed }; }
    await q('UPDATE users SET paused=true WHERE id=$1', [user.id]); changed.paused = true;
    return { reply: 'Posting paused across every channel. Clips keep banking — say “resume” anytime.', changed };
  }
  if (/\b(resume|unpause|start posting|keep posting)\b/.test(t)) {
    if (isChannel) { await setChan(user.id, convPlatform, 'paused', false); return { reply: 'Resumed posting for ' + handleFor(convPlatform) + '.', changed }; }
    await q('UPDATE users SET paused=false WHERE id=$1', [user.id]); changed.paused = false;
    return { reply: 'Posting resumed across every channel.', changed };
  }

  // ---- daily pace ----
  const paceM = t.match(/(\d+)\s*(?:clips?\s*)?(?:a|per)\s*day/) || t.match(/post\s*(\d+)\s*(?:a|per)?\s*day/);
  if (paceM && /\b(post|pace|clip|day)\b/.test(t)) {
    const n = Math.max(1, Math.min(24, parseInt(paceM[1], 10)));
    if (isChannel) { await setChan(user.id, convPlatform, 'daily_pace', n); return { reply: 'Pacing ' + handleFor(convPlatform) + ' to ' + n + (n === 1 ? ' clip' : ' clips') + ' a day.', changed }; }
    await q('UPDATE users SET daily_pace=$1 WHERE id=$2', [n, user.id]); changed.dailyPace = n;
    return { reply: 'Done — ' + n + (n === 1 ? ' clip' : ' clips') + ' a day on every channel.', changed };
  }

  // ---- clip length ----
  const len = lengthFromText(t);
  if (len && /(length|clip|short|make|set|minute|second|\ds)/.test(t)) {
    const platform = isChannel ? convPlatform : 'youtube';
    await setChan(user.id, platform, 'shorts_length', len);
    changed.channel = { platform, shortsLength: len };
    return { reply: 'Set ' + (isChannel ? handleFor(platform) : 'your ' + platform) + ' clips to ' + LENGTH_LABEL[len] + '.', changed };
  }

  // ---- standing rule (topics / titles / do's & don'ts) ----
  if (/^(always|never|don'?t|do not|rule:|only|focus|title|topic)/.test(t) || /\brule\b/.test(t)) {
    const rule = text.trim().replace(/^rule:\s*/i, '');
    if (isChannel) {
      const cur = await q('SELECT rules FROM channel_settings WHERE user_id=$1 AND platform=$2', [user.id, convPlatform]);
      const prev = (cur.rows[0] && cur.rows[0].rules) ? cur.rows[0].rules + '\n' : '';
      await setChan(user.id, convPlatform, 'rules', (prev + '• ' + rule).slice(0, 2000));
      return { reply: 'Saved that rule for ' + handleFor(convPlatform) + ' only.', changed };
    }
    const prev = user.rules ? user.rules + '\n' : '';
    const next = (prev + '• ' + rule).slice(0, 2000);
    await q('UPDATE users SET rules=$1 WHERE id=$2', [next, user.id]); changed.rules = next;
    return { reply: 'Saved that as a standing rule for every channel.', changed };
  }

  // ---- status ----
  if (/\b(status|how many|what'?s? connected|what is connected|where am i|summary|report)\b/.test(t)) {
    const counts = await q("SELECT count(*) FILTER (WHERE status='posted')::int posted, count(*) FILTER (WHERE status='banked')::int banked FROM clips WHERE user_id=$1" + (isChannel ? " AND platform=$2" : ''), isChannel ? [user.id, convPlatform] : [user.id]);
    const c = counts.rows[0] || { posted: 0, banked: 0 };
    if (isChannel) return { reply: handleFor(convPlatform) + ': ' + c.posted + ' posted, ' + c.banked + ' banked.', changed };
    const conn = await connectedCount(user.id);
    const freeLeft = Math.max(0, 10 - (user.free_clips_used || 0));
    return { reply: (conn === null ? '' : conn + ' channel' + (conn === 1 ? '' : 's') + ' connected. ') + (user.plan === 'free' ? 'Free — ' + freeLeft + ' of 10 free clips left. ' : 'On ' + user.plan + '. ') + c.posted + ' posted, ' + c.banked + ' banked.', changed };
  }

  // ---- honest fallback ----
  return { reply: 'I can change clip length, set daily pace, pause/resume, save a rule for ' + scope + ', give a status, or queue a video (paste the link). I couldn’t action that one — try one of those.', changed };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  if (!configured()) { res.status(501).json({ error: 'not_configured' }); return; }
  try {
    const user = await getUser(req);
    if (!user) { res.status(401).json({ error: 'unauthorized' }); return; }
    const text = (req.body && typeof req.body.text === 'string') ? req.body.text.trim() : '';
    if (!text) { res.status(400).json({ error: 'bad_request' }); return; }
    let conv = (req.body && typeof req.body.conversation === 'string' && req.body.conversation) || 'all';

    await q('INSERT INTO messages(user_id, role, text, conversation) VALUES ($1,$2,$3,$4)', [user.id, 'me', text.slice(0, 2000), conv]);
    const { reply, changed } = await handle(user, text, conv);
    await q('INSERT INTO messages(user_id, role, text, conversation) VALUES ($1,$2,$3,$4)', [user.id, 'agent', reply, conv]);

    res.status(200).json({ reply, changed, conversation: conv });
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
};

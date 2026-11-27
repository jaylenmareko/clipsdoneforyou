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

// ---- channel-watching helpers (the engine resolves + polls; site writes rows) ----
function watchLabel(r) { return String(r.title || r.handle || r.source || '').trim(); }
function listLine(rows) { return 'You’re watching: ' + rows.map(watchLabel).join(', ') + '.'; }
async function watchSummary(userId) {
  const rows = (await q('SELECT source, handle, title FROM watch_channels WHERE user_id=$1 AND active=true ORDER BY created_at ASC', [userId])).rows;
  if (!rows.length) return 'You’re not watching any channels yet. Say “watch @channel” (or paste a channel link) and I’ll clip new long uploads as they post.';
  return 'You’re watching ' + rows.length + (rows.length === 1 ? ' channel' : ' channels') + ': ' + rows.map(watchLabel).join(', ') + '. I clip their new long uploads automatically, up to your daily pace.';
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

  // ---- channel watching (engine resolves the channel + polls ~30min and
  // auto-queues clips for new long uploads; the site only writes rows). Checked
  // before the clip-URL block so "watch this channel: <link>" watches, not clips.
  if (/\bwhat\b[^?]*\bwatch/i.test(t) || /\b(?:am i|are we)\s+watching\b/i.test(t) || /\blist\b[^?]*\bwatch/i.test(t)) {
    return { reply: await watchSummary(user.id), changed };
  }
  if (/^\s*(?:stop\s+watching|unwatch)\b/i.test(t)) {
    const m = text.match(/(?:stop\s+watching|unwatch)\s*:?\s*(.*)$/i);
    const src = (m && m[1] || '').trim();
    const actives = (await q('SELECT source, handle, title FROM watch_channels WHERE user_id=$1 AND active=true ORDER BY created_at ASC', [user.id])).rows;
    if (!actives.length) return { reply: 'You’re not watching any channels right now.', changed };
    if (src) {
      const r = await q('UPDATE watch_channels SET active=false WHERE user_id=$1 AND active=true AND (source ILIKE $2 OR handle ILIKE $2 OR title ILIKE $2) RETURNING source, handle, title', [user.id, '%' + src + '%']);
      if (!r.rows.length) return { reply: 'I couldn’t find an active watch matching “' + src + '”. ' + listLine(actives), changed };
      return { reply: 'Stopped watching ' + watchLabel(r.rows[0]) + ' — no new uploads from it will be clipped.', changed };
    }
    if (actives.length === 1) {
      await q('UPDATE watch_channels SET active=false WHERE user_id=$1 AND active=true', [user.id]);
      return { reply: 'Stopped watching ' + watchLabel(actives[0]) + '.', changed };
    }
    return { reply: 'Which one should I stop watching? ' + listLine(actives), changed };
  }
  if (/^\s*watch\b/i.test(t)) {
    const m = text.match(/^\s*watch(?:\s+this\s+channel)?\s*:?\s*(.*)$/i);
    const source = (m && m[1] || '').trim();
    if (!source) return { reply: 'Tell me which channel — paste a channel link or @handle, like “watch @somechannel”.', changed };
    await q('INSERT INTO watch_channels(user_id, source, active) VALUES ($1,$2,true) ON CONFLICT (user_id, source) DO UPDATE SET active=true', [user.id, source.slice(0, 500)]);
    return { reply: 'Watching ' + source + ' — I’ll clip new long uploads automatically as they post, up to your daily pace.', changed };
  }

  // ---- verbatim reupload (engine downloads untouched + copies title/desc/tags/
  // thumbnail exactly; delivery follows plan rules). YouTube-only in v1. Checked
  // before the clip-URL block so "reupload <link>" never becomes a clip. ----
  if (/\b(re-?upload|re-?post)\b/i.test(t) || /\bpost\b[^.]*\bexact/i.test(t) || /\b(as[- ]?is|verbatim)\b/i.test(t) || /\bcopy\b[^.]*\b(as[- ]?is|exact|verbatim)/i.test(t)) {
    const rurl = (text.match(/https?:\/\/\S+/) || [])[0];
    const isYT = rurl && /(?:youtube\.com|youtu\.be)/i.test(rurl);
    const yt = channels.find((c) => c.platform === 'youtube');
    if (!rurl) return { reply: 'Paste the YouTube link you want reuploaded exactly as-is.', changed };
    if (!isYT) return { reply: 'That isn’t a YouTube link — verbatim reuploads are YouTube-only for now. Want me to clip it instead? Paste it and say “clip this”.', changed };
    if (!yt) return { reply: 'You don’t have a YouTube channel connected yet — connect one in Setup first. Or paste a link and I’ll clip it into shorts instead.', changed };
    await q("INSERT INTO jobs(user_id, type, payload, channel, priority) VALUES ($1,'reupload',$2,$3,10)", [user.id, JSON.stringify({ url: rurl }), 'youtube:' + yt.handle]);
    changed.queued = 'youtube:' + yt.handle;
    return { reply: 'Reuploading that exactly as-is — same video, title, description, tags, and thumbnail — to ' + yt.handle + '. It’ll show up in your Clips when it’s done.', changed };
  }

  // ---- clip request (any URL) ----
  const url = (text.match(/https?:\/\/\S+/) || [])[0];
  if (url && user.journey && user.journey.awaitingLinks && !isChannel) {
    await q("INSERT INTO jobs(user_id, type, payload, priority) VALUES ($1,'first_batch',$2,100)", [user.id, JSON.stringify({ source: 'link', url, count: 3 }), ]);
    const j = Object.assign({}, user.journey); j.awaitingLinks = false;
    await q('UPDATE users SET journey=$1 WHERE id=$2', [JSON.stringify(j), user.id]);
    changed.queued = conv;
    return { reply: "Got it — cutting your first clips from that video now. Your first ones post today. Paste more links anytime.", changed };
  }
  if (url) {
    let platform = convPlatform, targetConv = isChannel ? conv : null;
    if (!isChannel) {
      if (channels.length === 1) { platform = channels[0].platform; targetConv = chanKey(platform, channels[0].handle); }
      else if (channels.length > 1) { return { reply: 'Which channel should I clip that for? ' + channels.map((c) => c.handle).join(', ') + ' — tell me in that channel, or name it here.', changed }; }
    }
    await q("INSERT INTO jobs(user_id, type, payload, channel) VALUES ($1,'clip_request',$2,$3)", [user.id, JSON.stringify({ url, platform }), targetConv]);
    changed.queued = targetConv || conv;
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
  if (/\b(status|how many|what'?s? connected|what is connected|where am i|summary|report|did (?:it|they|you) post|is it posted|anything post)\b/.test(t)) {
    const counts = await q("SELECT count(*) FILTER (WHERE status='posted')::int posted, count(*) FILTER (WHERE status='banked')::int banked, count(*) FILTER (WHERE status='failed')::int failed FROM clips WHERE user_id=$1" + (isChannel ? " AND platform=$2" : ''), isChannel ? [user.id, convPlatform] : [user.id]);
    const c = counts.rows[0] || { posted: 0, banked: 0, failed: 0 };
    // failures must never be omitted — surface the plain-language reason too.
    let failPart = '';
    if (c.failed > 0) {
      const errR = await q("SELECT channel, payload FROM jobs WHERE user_id=$1 AND status='error' ORDER BY id DESC LIMIT 20", [user.id]);
      let reason = '';
      for (const r of errR.rows) {
        if (isChannel && (r.channel || '').split(':')[0] !== convPlatform) continue;
        reason = (r.payload && r.payload.engine_error) || ''; if (reason) break;
      }
      const daily = /daily|uploadlimit|youtube_channel_daily_limit/i.test(reason);
      failPart = ', ' + c.failed + ' failed (' + (daily ? 'YouTube daily upload limit — retrying automatically' : 'retrying automatically') + ')';
    }
    if (isChannel) return { reply: handleFor(convPlatform) + ': ' + c.posted + ' posted, ' + c.banked + ' banked' + failPart + '.', changed };
    const conn = await connectedCount(user.id);
    const freeLeft = Math.max(0, 10 - (user.free_clips_used || 0));
    const watches = (await q('SELECT source, handle, title FROM watch_channels WHERE user_id=$1 AND active=true ORDER BY created_at ASC', [user.id])).rows;
    const watchPart = watches.length ? ' Watching ' + watches.length + (watches.length === 1 ? ' channel' : ' channels') + ' (' + watches.map(watchLabel).join(', ') + ').' : '';
    return { reply: (conn === null ? '' : conn + ' channel' + (conn === 1 ? '' : 's') + ' connected. ') + (user.plan === 'free' ? 'Free — ' + freeLeft + ' of 10 free clips left. ' : 'On ' + user.plan + '. ') + c.posted + ' posted, ' + c.banked + ' banked' + failPart + '.' + watchPart, changed };
  }

  // ---- honest fallback ----
  return { reply: 'I can change clip length, set daily pace, pause/resume, save a rule for ' + scope + ', watch a channel for new uploads (give me a channel link or @handle), reupload a video exactly as-is (just say “reupload” and paste the link), give a status, or queue a video (paste the link). I couldn’t action that one — try one of those.', changed };
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

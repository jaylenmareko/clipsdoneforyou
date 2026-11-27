// ---------------------------------------------------------------------------
// Post-wizard journey state machine, per-channel aware.
//
// The external engine consumes `jobs` and writes real `clips` rows (status
// 'posted' with url+posted_at+platform, or 'banked'). This module never
// fabricates a clip/post/link — it reads what the engine produced and
// materializes the agent's chat messages, routed to the right conversation:
//   - A clip going live / the first-batch note  -> that channel's conversation
//     (key 'platform:handle'), with the real url.
//   - Account-level events (7-free heads-up, 10-free paywall, banking, plan
//     changes, weekly summary, the one-time "change anything by chatting" note)
//     -> the 'all' (All channels) conversation.
//
// `users.journey` (jsonb) tracks per-channel and account milestones so each
// message is emitted exactly once, idempotently, on each app sync.
// ---------------------------------------------------------------------------
const { q } = require('./_db');

function isoDate(d) { return new Date(d).toISOString().slice(0, 10); }
function isoWeek(d) {
  const dt = new Date(d); const day = (dt.getUTCDay() + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((dt - firstThu) / 864e5 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return dt.getUTCFullYear() + '-W' + String(week).padStart(2, '0');
}
function chanKey(platform, handle) { return platform + ':' + (handle || platform); }
function links(a) { return a.map((c) => '• ' + c.url).join('\n'); }
async function agent(userId, conversation, text) {
  await q('INSERT INTO messages(user_id, role, text, conversation) VALUES ($1,$2,$3,$4)', [userId, 'agent', text, conversation]);
}

// Kick off the first batch per connected channel the moment the wizard/gate
// completes. Idempotent per channel. `connected` = live /api/status map.
async function start(user, connected) {
  const j = Object.assign({ started: {} }, user.journey || {});
  j.started = j.started || {};
  const platforms = Object.keys(connected || {}).filter((p) => connected[p]);
  let changed = false;

  if (!platforms.length) {
    if (!j.started._none && !j.awaitingLinks) {
      await agent(user.id, 'all', "I'm ready to start — I just need a video. Paste a link to one of your long videos here and I'll cut the best moments and post them today.");
      j.awaitingLinks = true; j.started._none = true; changed = true;
    }
  } else {
    for (const p of platforms) {
      if (j.started[p]) continue;
      const handle = connected[p].handle;
      const key = chanKey(p, handle);
      await q("INSERT INTO jobs(user_id, type, payload, priority, channel) VALUES ($1,'first_batch',$2,100,$3)",
        [user.id, JSON.stringify({ source: 'youtube_channel', strategy: 'most_watched_long', count: 3, platform: p, handle }), key]);
      // first message in this channel's thread: the scoped "what you can do here" note, once.
      const h = handle && String(handle).charAt(0) === '@' ? handle : '@' + (handle || p);
      await agent(user.id, key, "This thread is just for " + h + ". Anything you tell me here — length, pace, topics, pausing — applies to this channel only. For everything at once, use All channels.");
      j.started[p] = true; j.awaitingLinks = false; changed = true;
    }
    // first message in the All channels thread: the one-time "what you can do
    // here" note, posted once the moment a channel connects (replaces the old
    // "change anything by chatting" note — never both).
    if (!j.startMsgSent) {
      await agent(user.id, 'all', `You're live — I'm already picking your first clips. You don't have to set anything up; I handle the clipping and posting.

If you want anything changed, just tell me here, like:
• "Clip this video: [paste a link]"
• "Make my clips shorter — under a minute"
• "Post 5 a day instead of 3"
• "Pause posting" or "Start again"
• "Always grab the parts about money" / "Never post about politics"
• "What's posted so far?"

Anything about your clips — just ask here.`);
      j.startMsgSent = true; changed = true;
    }
  }
  if (changed) { await q('UPDATE users SET journey=$1 WHERE id=$2', [JSON.stringify(j), user.id]); user.journey = j; }
  return j;
}

// Emit milestone messages the real state warrants, each once, correctly routed.
async function reconcile(user) {
  const j = Object.assign({ started: {}, firstPosts: {}, lastDaily: {} }, user.journey || {});
  j.started = j.started || {}; j.firstPosts = j.firstPosts || {}; j.lastDaily = j.lastDaily || {};
  const before = JSON.stringify(j);

  const clipsR = await q("SELECT status, url, platform, posted_at, created_at FROM clips WHERE user_id=$1 ORDER BY posted_at ASC NULLS LAST, id ASC", [user.id]);
  const csR = await q('SELECT platform, handle FROM channel_settings WHERE user_id=$1', [user.id]);
  const handleMap = {}; csR.rows.forEach((r) => { handleMap[r.platform] = r.handle; });

  const posted = clipsR.rows.filter((c) => c.status === 'posted');
  const banked = clipsR.rows.filter((c) => c.status === 'banked');
  const postedCount = posted.length, bankedCount = banked.length;
  const plan = user.plan;
  const byPlatform = {};
  posted.forEach((c) => { const p = c.platform || 'youtube'; (byPlatform[p] = byPlatform[p] || []).push(c); });

  let anyFirst = false;
  for (const p of Object.keys(byPlatform)) {
    const cs = byPlatform[p];
    const key = chanKey(p, handleMap[p]);
    // first clips live for this channel
    if (!j.firstPosts[p] && cs.length >= 1) {
      const firstDate = cs[0].posted_at ? isoDate(cs[0].posted_at) : null;
      const firstBatch = firstDate ? cs.filter((c) => c.posted_at && isoDate(c.posted_at) === firstDate) : cs.slice(0, 3);
      await agent(user.id, key, 'Your first clips are live:\n' + links(firstBatch));
      j.firstPosts[p] = true; if (firstDate) j.lastDaily[p] = firstDate; anyFirst = true;
    } else if (j.firstPosts[p]) {
      // daily "N posted today" for this channel
      const dates = cs.filter((c) => c.posted_at).map((c) => isoDate(c.posted_at));
      const latest = dates.length ? dates[dates.length - 1] : null;
      if (latest && latest !== j.lastDaily[p]) {
        const dayClips = cs.filter((c) => c.posted_at && isoDate(c.posted_at) === latest);
        await agent(user.id, key, dayClips.length + ' posted today:\n' + links(dayClips));
        j.lastDaily[p] = latest;
      }
    }
  }

  // (the one-time "what you can do here" note is now posted at connect in
  // start(), to the All channels thread — see there. No change-note here.)

  // ---- per-job outcome: never leave a job silent after "Queued" ----
  // Each clip-producing job ends terminal — 'error'/'failed' on failure, or a
  // success status on completion (the exact string isn't assumed). We announce
  // every job's outcome exactly once, keyed on its id, routed to its channel:
  //   failure -> plain-language reason (e.g. daily upload limit, retrying);
  //   success that posted -> the "live"/"posted today" messages above carry the
  //     count + links, so we stay silent to avoid duplicates;
  //   success that only banked -> a short "N ready and banked" note.
  const CLIP_JOB_TYPES = ['clip_request', 'first_batch', 'daily_batch', 'post_now', 'reupload'];
  const isFailure = (s) => /^(error|failed|cancell?ed)$/i.test(s || '');
  const isTerminal = (s) => /^(error|failed|cancell?ed|done|complete|completed|posted|finished|skipped)$/i.test(s || '');
  const jobsR = await q('SELECT id, type, status, channel, payload, created_at FROM jobs WHERE user_id=$1 AND type = ANY($2) ORDER BY id ASC', [user.id, CLIP_JOB_TYPES]);
  const seeding = (j.announcedJobs === undefined || j.announcedJobs === null);
  j.announcedJobs = j.announcedJobs || {};
  for (const r of jobsR.rows) {
    const id = String(r.id);
    if (seeding) { if (isTerminal(r.status)) j.announcedJobs[id] = true; continue; } // first run: don't backfill old jobs
    if (!isTerminal(r.status) || j.announcedJobs[id]) continue;
    const p = (r.channel || '').split(':')[0] || (r.payload && r.payload.platform) || 'youtube';
    const key = r.channel || chanKey(p, handleMap[p]);
    if (isFailure(r.status)) {
      const reason = (r.payload && r.payload.engine_error) || '';
      const daily = /daily|uploadlimit|youtube_channel_daily_limit/i.test(reason);
      const nFailed = clipsR.rows.filter((c) => (c.platform || 'youtube') === p && c.status === 'failed').length;
      const some = nFailed > 0 ? (nFailed + (nFailed === 1 ? ' clip' : ' clips')) : 'A few clips';
      await agent(user.id, key, daily
        ? some + ' are ready, but ' + (handleMap[p] || 'this channel') + ' hit YouTube’s daily upload limit — I’ll post them automatically once it resets.'
        : some + ' couldn’t post just yet — I’ll keep trying; they’ll go up automatically.');
    } else {
      // success: attribute this job's clips by time, announce only if banked-only
      const since = r.created_at ? new Date(r.created_at).getTime() - 60000 : 0;
      const mine = clipsR.rows.filter((c) => (c.platform || 'youtube') === p && new Date(c.created_at || 0).getTime() >= since);
      const postedMine = mine.filter((c) => c.status === 'posted');
      const bankedMine = mine.filter((c) => c.status === 'banked');
      if (!postedMine.length && bankedMine.length) {
        await agent(user.id, key, bankedMine.length + (bankedMine.length === 1 ? ' clip is' : ' clips are') + ' ready and banked — '
          + (plan === 'free' ? 'they post as soon as you subscribe.' : 'they post as your pacing allows.'));
      }
    }
    j.announcedJobs[id] = true;
  }

  // ---- account-level events -> 'all' ----
  if (plan !== 'free' && j.subConfirmedPlan !== plan) {
    await agent(user.id, 'all', "You're on " + plan + ' — your banked clips are posting now, and each one shows up in its channel. Back to daily from here.');
    j.subConfirmedPlan = plan;
  }
  if (plan === 'free' && !j.heads7Sent && postedCount >= 7) {
    await agent(user.id, 'all', Math.max(0, 10 - postedCount) + ' of your 10 free clips left.');
    j.heads7Sent = true;
  }
  if (plan === 'free' && !j.paywall10Sent && postedCount >= 10) {
    await agent(user.id, 'all', "That's your 10 free clips used — posting pauses here, but I keep clipping."
      + (bankedCount ? ' ' + bankedCount + ' are made and waiting.' : '')
      + ' Subscribe and your banked clips post today. Nothing gets deleted.');
    j.paywall10Sent = true;
  }
  if (plan !== 'free' && j.subConfirmedPlan === plan && postedCount > 0) {
    const wk = isoWeek(Date.now());
    if (j._weeklyArmed && j.lastWeeklyWeek !== wk) {
      const weekClips = posted.filter((c) => c.posted_at && isoWeek(c.posted_at) === wk);
      await agent(user.id, 'all', weekClips.length + ' clips posted this week — ' + postedCount + ' total.');
      j.lastWeeklyWeek = wk;
    }
    j._weeklyArmed = true; // armed after the first post-sub reconcile; weekly never fires the same run as subscribe
  }

  if (JSON.stringify(j) !== before) { await q('UPDATE users SET journey=$1 WHERE id=$2', [JSON.stringify(j), user.id]); user.journey = j; }
  return { postedCount, bankedCount };
}

module.exports = { start, reconcile, chanKey };

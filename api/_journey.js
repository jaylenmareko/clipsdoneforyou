// ---------------------------------------------------------------------------
// Post-wizard journey state machine.
//
// The clipping/posting ENGINE runs outside this site. It consumes the `jobs`
// queue and writes real rows into `clips` (status 'posted' with a live `url`
// and `posted_at`, or 'banked' while the free limit holds). This module never
// fabricates a clip, post, or link — it only reads what the engine produced and
// materializes the agent's chat messages at the right moments, each once.
//
// `users.journey` (jsonb) tracks which milestones have fired so every message
// is emitted exactly once, idempotently, on each app sync.
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
function links(clips) { return clips.map((c) => '• ' + c.url).join('\n'); }
async function agent(userId, text) {
  await q('INSERT INTO messages(user_id, role, text) VALUES ($1,$2,$3)', [userId, 'agent', text]);
}

// Kick off the first batch the moment the wizard/gate completes. Idempotent.
// `connected` is the live /api/status connected map (so we pick a real source).
async function start(user, connected) {
  const j = Object.assign({}, user.journey || {});
  if (j.started) { return j; }
  const hasYouTube = !!(connected && connected.youtube);

  if (hasYouTube) {
    await q("INSERT INTO jobs(user_id, type, payload, priority) VALUES ($1,'first_batch',$2,100)",
      [user.id, JSON.stringify({ source: 'youtube_channel', strategy: 'most_watched_long', count: 3 })]);
    await agent(user.id, "On it — I'm pulling from your most-watched long videos and cutting your first clips. Your first ones post today.");
    j.started = true; j.awaitingLinks = false;
  } else {
    await agent(user.id, "I'm ready to start — I just need a video. Paste a link to one of your long videos here and I'll cut the best moments and post them today.");
    j.started = true; j.awaitingLinks = true;
  }
  await q('UPDATE users SET journey=$1 WHERE id=$2', [JSON.stringify(j), user.id]);
  user.journey = j;
  return j;
}

// Emit any milestone messages the real state now warrants. Each fires once.
async function reconcile(user) {
  const j = Object.assign({}, user.journey || {});
  const r = await q(
    "SELECT status, url, posted_at FROM clips WHERE user_id=$1 ORDER BY posted_at ASC NULLS LAST, id ASC", [user.id]);
  const posted = r.rows.filter((c) => c.status === 'posted');
  const banked = r.rows.filter((c) => c.status === 'banked');
  const postedCount = posted.length, bankedCount = banked.length;
  const plan = user.plan;
  const before = JSON.stringify(j);
  let subJustConfirmed = false;

  // 1. first posts live + the one-time "change anything by chatting" note
  if (j.started && !j.firstPostsAnnounced && postedCount >= 1) {
    const firstDate = posted[0].posted_at ? isoDate(posted[0].posted_at) : null;
    const firstBatch = firstDate ? posted.filter((c) => c.posted_at && isoDate(c.posted_at) === firstDate) : posted.slice(0, 3);
    await agent(user.id, 'Your first clips are live:\n' + links(firstBatch));
    j.firstPostsAnnounced = true; if (firstDate) j.lastDailyDate = firstDate;
    if (!j.changeNoteSent) {
      await agent(user.id, "Want them longer, shorter, more per day, or different topics? Just tell me here and I'll adjust.");
      j.changeNoteSent = true;
    }
  }

  // 2. subscribe confirmation — the bank just released; announce it, suppress today's daily
  if (plan !== 'free' && j.subConfirmedPlan !== plan) {
    const today = isoDate(Date.now());
    const todayClips = posted.filter((c) => c.posted_at && isoDate(c.posted_at) === today);
    await agent(user.id, "You're on " + plan + ' — your banked clips are posting now'
      + (todayClips.length ? ':\n' + links(todayClips) : '.') + '\nBack to daily from here.');
    j.subConfirmedPlan = plan; j.lastDailyDate = today; subJustConfirmed = true;
  }

  // 3. daily "N posted today" with real links
  if (j.firstPostsAnnounced && !subJustConfirmed && postedCount > 0) {
    const dates = posted.filter((c) => c.posted_at).map((c) => isoDate(c.posted_at));
    const latest = dates.length ? dates[dates.length - 1] : null;
    if (latest && latest !== j.lastDailyDate) {
      const dayClips = posted.filter((c) => c.posted_at && isoDate(c.posted_at) === latest);
      await agent(user.id, dayClips.length + ' posted today:\n' + links(dayClips));
      j.lastDailyDate = latest;
    }
  }

  // 4. soft heads-up at 7 free clips
  if (plan === 'free' && !j.heads7Sent && postedCount >= 7) {
    await agent(user.id, Math.max(0, 10 - postedCount) + ' of your 10 free clips left.');
    j.heads7Sent = true;
  }

  // 5. paywall at 10 — posting pauses, clips keep banking
  if (plan === 'free' && !j.paywall10Sent && postedCount >= 10) {
    await agent(user.id, "That's your 10 free clips used — posting pauses here, but I keep clipping."
      + (bankedCount ? ' ' + bankedCount + ' are made and waiting.' : '')
      + ' Subscribe and your banked clips post today. Nothing gets deleted.');
    j.paywall10Sent = true;
  }

  // 6. weekly summary (post-subscription only)
  if (plan !== 'free' && j.subConfirmedPlan && !subJustConfirmed && postedCount > 0) {
    const wk = isoWeek(Date.now());
    if (j.lastWeeklyWeek !== wk) {
      const weekClips = posted.filter((c) => c.posted_at && isoWeek(c.posted_at) === wk);
      await agent(user.id, weekClips.length + ' clips posted this week — ' + postedCount + ' total.');
      j.lastWeeklyWeek = wk;
    }
  }

  if (JSON.stringify(j) !== before) {
    await q('UPDATE users SET journey=$1 WHERE id=$2', [JSON.stringify(j), user.id]);
    user.journey = j;
  }
  return { postedCount, bankedCount };
}

module.exports = { start, reconcile };

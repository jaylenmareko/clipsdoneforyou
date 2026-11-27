// GET /api/me — the app's bootstrap state for the signed-in user.
// Called on every page load so the session restores across refresh. Returns
// only this user's data. { authenticated:false } when there is no valid session.
const { q, configured } = require('./_db');
const { getUser } = require('./_auth');
const provider = require('./_provider');
const journey = require('./_journey');

module.exports = async (req, res) => {
  if (!configured()) { res.status(200).json({ authenticated: false, configured: false }); return; }
  try {
    const u = await getUser(req);
    if (!u) { res.status(200).json({ authenticated: false, configured: true }); return; }

    // Resolve live connection state, persist each channel's handle (so
    // conversations + routing survive a disconnect), then run the post-wizard
    // journey (idempotent) — start the first batch per connected channel and
    // materialize any milestone messages the real DB state now warrants.
    let connected = {};
    if (provider.configured()) {
      try {
        const st = await provider.getStatus(u.id).catch(() => ({ error: 'upstream' }));
        connected = st.connected || {};
        for (const [p, c] of Object.entries(connected)) {
          if (c && c.handle) {
            await q(`INSERT INTO channel_settings(user_id, platform, handle) VALUES ($1,$2,$3)
                     ON CONFLICT (user_id, platform) DO UPDATE SET handle = EXCLUDED.handle`, [u.id, p, c.handle]);
          }
        }
        if (Object.keys(connected).length) { await journey.start(u, connected); }
        await journey.reconcile(u);
      } catch (e) { /* journey is best-effort; never block app state */ }
    }

    const [cs, msgs, counts, active] = await Promise.all([
      q('SELECT platform, handle, shorts_length AS "shortsLength", medium_form AS "mediumForm", rules, paused, daily_pace AS "dailyPace" FROM channel_settings WHERE user_id = $1', [u.id]),
      q('SELECT role, text, conversation FROM messages WHERE user_id = $1 ORDER BY id ASC LIMIT 400', [u.id]),
      q(`SELECT
           count(*) FILTER (WHERE status = 'posted') AS posted,
           count(*) FILTER (WHERE status = 'banked') AS banked
         FROM clips WHERE user_id = $1`, [u.id]),
      // in-flight clip jobs: anything NOT in a terminal status is "working".
      // Drives the chat progress indicator (#3). Status-agnostic on purpose —
      // the engine's exact success/claim strings aren't assumed.
      q(`SELECT channel FROM jobs
         WHERE user_id = $1
           AND type IN ('clip_request','first_batch','daily_batch','post_now')
           AND lower(status) NOT IN ('error','failed','cancelled','canceled','done','complete','completed','posted','finished','skipped')`, [u.id]),
    ]);

    const row = counts.rows[0] || { posted: 0, banked: 0 };

    // ---- source picker (#4): the connected channel's recent long-form videos.
    // The engine fills `source_videos` via a `list_sources` job. We read whatever
    // rows exist, refresh in the background when they're missing or >24h stale,
    // and never block chat on it. Best-effort — if the table isn't there yet we
    // just show no picker.
    let sourceVideos = [], sourceStatus = 'ready', sourceError = '';
    if (provider.configured() && Object.keys(connected).length) {
      try {
        const sv = await q(`SELECT video_id, title, thumbnail_url, duration_s, views, published_at, channel, fetched_at
                            FROM source_videos WHERE user_id=$1 ORDER BY published_at DESC NULLS LAST, fetched_at DESC`, [u.id]);
        sourceVideos = sv.rows.map((r) => ({
          videoId: r.video_id, title: r.title, thumbnailUrl: r.thumbnail_url,
          durationS: r.duration_s, views: r.views != null ? Number(r.views) : null,
          publishedAt: r.published_at, channel: r.channel,
        }));
        let newest = null;
        sv.rows.forEach((r) => { if (r.fetched_at && (!newest || r.fetched_at > newest)) newest = r.fetched_at; });
        const stale = !sv.rows.length || !newest || (Date.now() - new Date(newest).getTime() > 24 * 3600 * 1000);
        const lj = await q("SELECT status, payload FROM jobs WHERE user_id=$1 AND type='list_sources' ORDER BY id DESC LIMIT 1", [u.id]);
        const latest = lj.rows[0];
        const running = latest && !/^(error|failed|cancell?ed|done|complete|completed|finished|skipped)$/i.test(latest.status);
        const latestError = latest && /^(error|failed)$/i.test(latest.status);
        if (stale && !running && !latestError) {
          for (const [p, c] of Object.entries(connected)) {
            if (!c) continue;
            const key = p + ':' + (c.handle || p);
            await q("INSERT INTO jobs(user_id, type, channel, payload, status) VALUES ($1,'list_sources',$2,'{}'::jsonb,'queued')", [u.id, key]);
          }
        }
        if (sourceVideos.length) sourceStatus = 'ready';
        else if (running || (stale && !latestError)) sourceStatus = 'loading';
        else if (latestError) { sourceStatus = 'error'; sourceError = (latest.payload && latest.payload.engine_error) || 'Could not load your recent videos.'; }
        else sourceStatus = 'loading';
      } catch (e) { sourceVideos = []; sourceStatus = 'ready'; }
    }

    // ---- watched channels (engine resolves + polls; site only writes rows) ----
    let watches = [];
    try {
      const w = await q('SELECT source, channel_id, handle, title, active FROM watch_channels WHERE user_id=$1 AND active=true ORDER BY created_at ASC', [u.id]);
      watches = w.rows.map((r) => ({ source: r.source, channelId: r.channel_id, handle: r.handle, title: r.title }));
    } catch (e) { watches = []; }

    res.status(200).json({
      authenticated: true,
      configured: true,
      user: {
        id: u.id,
        email: u.email,
        plan: u.plan,
        paused: u.paused,
        dailyPace: u.daily_pace,
        rules: u.rules || '',
        freeClipsUsed: Number(row.posted),
        freeClipsLeft: Math.max(0, 10 - Number(row.posted)),
        postedClips: Number(row.posted),
        bankedClips: Number(row.banked),
        journey: u.journey || {},
      },
      channelSettings: cs.rows,
      messages: msgs.rows,
      connected: connected,
      activeJobs: active.rows.map((r) => ({ channel: r.channel || 'all' })),
      sourceVideos: sourceVideos,
      sourceStatus: sourceStatus,
      sourceError: sourceError,
      watches: watches,
    });
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
};

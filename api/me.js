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

    const [cs, msgs, counts] = await Promise.all([
      q('SELECT platform, handle, shorts_length AS "shortsLength", medium_form AS "mediumForm", rules FROM channel_settings WHERE user_id = $1', [u.id]),
      q('SELECT role, text, conversation FROM messages WHERE user_id = $1 ORDER BY id ASC LIMIT 400', [u.id]),
      q(`SELECT
           count(*) FILTER (WHERE status = 'posted') AS posted,
           count(*) FILTER (WHERE status = 'banked') AS banked
         FROM clips WHERE user_id = $1`, [u.id]),
    ]);

    const row = counts.rows[0] || { posted: 0, banked: 0 };
    res.status(200).json({
      authenticated: true,
      configured: true,
      user: {
        id: u.id,
        firstName: u.first_name,
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
    });
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
};

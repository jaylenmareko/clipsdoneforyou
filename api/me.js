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

    // Run the post-wizard journey (idempotent): start the first batch once a
    // channel is connected, then materialize any milestone messages the real
    // DB state now warrants. Done here because /api/me is the app's entry read.
    if (provider.configured()) {
      try {
        if (!(u.journey && u.journey.started)) {
          const st = await provider.getStatus(u.id).catch(() => ({ error: 'upstream' }));
          if (st.connected) { await journey.start(u, st.connected); }
        }
        await journey.reconcile(u);
      } catch (e) { /* journey is best-effort; never block app state */ }
    }

    const [cs, msgs, counts] = await Promise.all([
      q('SELECT platform, shorts_length AS "shortsLength", medium_form AS "mediumForm" FROM channel_settings WHERE user_id = $1', [u.id]),
      q('SELECT role, text FROM messages WHERE user_id = $1 ORDER BY id ASC LIMIT 200', [u.id]),
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
    });
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
};

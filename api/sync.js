// POST /api/sync
// Runs the post-wizard journey on app entry: starts the first batch the moment
// a channel is connected, then materializes any milestone agent messages the
// real DB state now warrants. Returns the full, updated message thread plus
// live counts. Side-effecting but idempotent — safe to call on every load.
const { q, configured } = require('./_db');
const { getUser } = require('./_auth');
const provider = require('./_provider');
const journey = require('./_journey');

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  if (!configured()) { res.status(501).json({ error: 'not_configured' }); return; }
  try {
    const u = await getUser(req);
    if (!u) { res.status(401).json({ error: 'unauthorized' }); return; }

    // Start the first batch only once we can confirm a real connected source.
    if (!(u.journey && u.journey.started) && provider.configured()) {
      const st = await provider.getStatus(u.id).catch(() => ({ error: 'upstream' }));
      if (st.connected) { await journey.start(u, st.connected); }
    }
    const counts = await journey.reconcile(u);

    const msgs = await q('SELECT role, text FROM messages WHERE user_id=$1 ORDER BY id ASC LIMIT 300', [u.id]);
    res.status(200).json({
      ok: true,
      messages: msgs.rows,
      postedClips: counts.postedCount,
      bankedClips: counts.bankedCount,
      freeClipsLeft: Math.max(0, 10 - counts.postedCount),
    });
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
};

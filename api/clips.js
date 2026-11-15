// GET /api/clips — real clip folders for the signed-in user, grouped by source
// video. Clips are written by the external clipping/posting engine; this site
// only reads them. A new user has none, so the client shows an empty state.
const { q, configured } = require('./_db');
const { getUser } = require('./_auth');

module.exports = async (req, res) => {
  if (!configured()) { res.status(200).json({ folders: [] }); return; }
  try {
    const u = await getUser(req);
    if (!u) { res.status(401).json({ error: 'unauthorized' }); return; }

    const r = await q(
      `SELECT source_title AS title,
              count(*)::int AS total,
              count(*) FILTER (WHERE status = 'posted')::int AS posted,
              count(*) FILTER (WHERE status = 'banked')::int AS banked,
              max(created_at) AS last
       FROM clips WHERE user_id = $1
       GROUP BY source_title
       ORDER BY last DESC`, [u.id]);

    res.status(200).json({ folders: r.rows.map((f) => ({ title: f.title, total: f.total, posted: f.posted, banked: f.banked })) });
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
};

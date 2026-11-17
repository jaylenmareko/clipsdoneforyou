// GET /api/clips — the signed-in user's clips, grouped by source video. Returns
// individual clips (status, posted URL, date) so the Clips tab can show real
// cards, not just counts. Clips are written by the external engine; this site
// only reads them. A failed clip's reason is derived from its channel's errored
// job (the engine records the reason there, not per-clip).
const { q, configured } = require('./_db');
const { getUser } = require('./_auth');

module.exports = async (req, res) => {
  if (!configured()) { res.status(200).json({ folders: [] }); return; }
  try {
    const u = await getUser(req);
    if (!u) { res.status(401).json({ error: 'unauthorized' }); return; }

    const [clipsR, errR] = await Promise.all([
      q(`SELECT id, source_title, platform, status, url, posted_at, created_at
         FROM clips WHERE user_id = $1 ORDER BY created_at ASC, id ASC`, [u.id]),
      q("SELECT channel, payload FROM jobs WHERE user_id = $1 AND status = 'error' ORDER BY id DESC", [u.id]),
    ]);

    // latest failure reason per platform (for 'failed' clips)
    const reasonByPlat = {};
    errR.rows.forEach((j) => {
      const pf = (j.channel || '').split(':')[0];
      if (pf && reasonByPlat[pf] === undefined) reasonByPlat[pf] = (j.payload && j.payload.engine_error) || '';
    });
    function reasonFor(c) {
      if (c.status !== 'failed') return '';
      const raw = reasonByPlat[c.platform] || '';
      return /daily|uploadlimit|youtube_channel_daily_limit/i.test(raw) ? 'daily_limit' : (raw ? 'other' : '');
    }

    const map = new Map();
    clipsR.rows.forEach((c) => {
      if (!map.has(c.source_title)) map.set(c.source_title, { title: c.source_title, platform: c.platform, total: 0, posted: 0, banked: 0, failed: 0, last: c.created_at, clips: [] });
      const f = map.get(c.source_title);
      f.total++;
      if (c.status === 'posted') f.posted++; else if (c.status === 'banked') f.banked++; else if (c.status === 'failed') f.failed++;
      if (new Date(c.created_at) > new Date(f.last)) f.last = c.created_at;
      f.clips.push({ id: String(c.id), status: c.status, url: c.url || null, platform: c.platform, postedAt: c.posted_at, createdAt: c.created_at, reason: reasonFor(c) });
    });
    const folders = Array.from(map.values()).sort((a, b) => new Date(b.last) - new Date(a.last));

    res.status(200).json({ folders });
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
};

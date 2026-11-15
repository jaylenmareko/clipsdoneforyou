// POST /api/settings — persist account + per-channel settings for the signed-in
// user. Accepts partial updates. Per-channel formats (Shorts length, medium-form)
// are keyed by (user, platform) so formats belong to each channel, not the account.
const { q, configured } = require('./_db');
const { getUser } = require('./_auth');

const LENGTHS = ['auto', 'under30', '30-60', '60-90', '90-180'];

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  if (!configured()) { res.status(501).json({ error: 'not_configured' }); return; }

  try {
    const u = await getUser(req);
    if (!u) { res.status(401).json({ error: 'unauthorized' }); return; }

    const b = req.body || {};

    if (b.dailyPace !== undefined) {
      const n = parseInt(b.dailyPace, 10);
      if (!Number.isFinite(n) || n < 1 || n > 24) { res.status(400).json({ error: 'bad_request' }); return; }
      await q('UPDATE users SET daily_pace = $1 WHERE id = $2', [n, u.id]);
    }
    if (b.paused !== undefined) {
      await q('UPDATE users SET paused = $1 WHERE id = $2', [!!b.paused, u.id]);
    }
    if (b.rules !== undefined) {
      await q('UPDATE users SET rules = $1 WHERE id = $2', [String(b.rules).slice(0, 2000), u.id]);
    }

    if (b.platform) {
      const platform = String(b.platform).toLowerCase();
      const len = LENGTHS.includes(b.shortsLength) ? b.shortsLength : 'auto';
      const med = !!b.mediumForm;
      await q(
        `INSERT INTO channel_settings(user_id, platform, shorts_length, medium_form)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (user_id, platform)
         DO UPDATE SET shorts_length = EXCLUDED.shorts_length, medium_form = EXCLUDED.medium_form`,
        [u.id, platform, len, med]);
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
};

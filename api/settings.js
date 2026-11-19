// POST /api/settings — persist account profile, account posting defaults, and
// per-channel settings for the signed-in user. Accepts partial updates; writes
// to the same columns as before (chat writes the same ones), so every surface
// reads one source of truth. No schema changes.
const bcrypt = require('bcryptjs');
const { q, configured } = require('./_db');
const { getUser } = require('./_auth');

const LENGTHS = ['auto', 'under30', '30-60', '60-90', '90-180'];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  if (!configured()) { res.status(501).json({ error: 'not_configured' }); return; }

  try {
    const u = await getUser(req);
    if (!u) { res.status(401).json({ error: 'unauthorized' }); return; }
    const b = req.body || {};

    // ---- account profile (Setup tab) — email + password only, no name ----
    if (b.email !== undefined) {
      const em = String(b.email).trim().toLowerCase();
      if (!EMAIL_RE.test(em)) { res.status(400).json({ error: 'bad_email' }); return; }
      const ex = await q('SELECT 1 FROM users WHERE email = $1 AND id <> $2', [em, u.id]);
      if (ex.rows.length) { res.status(409).json({ error: 'email_taken' }); return; }
      await q('UPDATE users SET email = $1 WHERE id = $2', [em, u.id]);
    }
    if (b.newPassword !== undefined) {
      const np = String(b.newPassword);
      if (np.length < 6) { res.status(400).json({ error: 'weak_password' }); return; }
      const ok = await bcrypt.compare(String(b.currentPassword || ''), u.password_hash);
      if (!ok) { res.status(403).json({ error: 'wrong_password' }); return; }
      await q('UPDATE users SET password_hash = $1 WHERE id = $2', [await bcrypt.hash(np, 10), u.id]);
    }

    // ---- account posting defaults (Clips tab) ----
    if (b.dailyPace !== undefined) {
      const n = parseInt(b.dailyPace, 10);
      if (!Number.isFinite(n) || n < 1 || n > 24) { res.status(400).json({ error: 'bad_request' }); return; }
      await q('UPDATE users SET daily_pace = $1 WHERE id = $2', [n, u.id]);
    }
    if (b.paused !== undefined) { await q('UPDATE users SET paused = $1 WHERE id = $2', [!!b.paused, u.id]); }
    if (b.rules !== undefined) { await q('UPDATE users SET rules = $1 WHERE id = $2', [String(b.rules).slice(0, 2000), u.id]); }

    // ---- per-channel settings (Clips tab) — NULL pace/paused means "follow account" ----
    if (b.platform) {
      const platform = String(b.platform).toLowerCase();
      await q('INSERT INTO channel_settings(user_id, platform) VALUES ($1,$2) ON CONFLICT (user_id, platform) DO NOTHING', [u.id, platform]);
      if (b.shortsLength !== undefined) {
        await q('UPDATE channel_settings SET shorts_length = $1 WHERE user_id=$2 AND platform=$3', [LENGTHS.includes(b.shortsLength) ? b.shortsLength : 'auto', u.id, platform]);
      }
      if (b.mediumForm !== undefined) {
        await q('UPDATE channel_settings SET medium_form = $1 WHERE user_id=$2 AND platform=$3', [!!b.mediumForm, u.id, platform]);
      }
      if ('channelPaused' in b) {
        await q('UPDATE channel_settings SET paused = $1 WHERE user_id=$2 AND platform=$3', [b.channelPaused === null ? null : !!b.channelPaused, u.id, platform]);
      }
      if ('channelPace' in b) {
        let pace = b.channelPace;
        if (pace === null || pace === '' || pace === undefined) pace = null;
        else { pace = parseInt(pace, 10); if (!Number.isFinite(pace) || pace < 1 || pace > 24) pace = null; }
        await q('UPDATE channel_settings SET daily_pace = $1 WHERE user_id=$2 AND platform=$3', [pace, u.id, platform]);
      }
      if (b.channelRules !== undefined) {
        await q('UPDATE channel_settings SET rules = $1 WHERE user_id=$2 AND platform=$3', [String(b.channelRules).slice(0, 2000), u.id, platform]);
      }
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
};

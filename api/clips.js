// /api/clips — the Clips tab's data + actions.
//   GET  -> this user's clips as a flat, newest-first list (one card each),
//           plus account cap state. Clips are written by the engine; the site
//           only reads them here.
//   POST -> per-clip actions the SITE owns: edit (title/description), delete,
//           and upload/retry. Upload never bypasses plan rules: it enqueues a
//           post job for the engine (same path as auto-posting) and, for a free
//           user at the 10-clip cap, refuses to post (returns 'capped'). The
//           engine executes post_now/update_post/delete_post jobs and flips the
//           clip's real status — the site never fabricates a posted row.
const { q, configured } = require('./_db');
const { getUser } = require('./_auth');

const UPLOADABLE = { banked: 1, queued: 1, failed: 1 };

async function postedCountFor(userId) {
  const r = await q("SELECT count(*)::int n FROM clips WHERE user_id=$1 AND status='posted'", [userId]);
  return r.rows[0].n;
}

async function listClips(user, res) {
  const [clipsR, csR, errR] = await Promise.all([
    q(`SELECT id, source_title, title, description, platform, status, url, posted_at, created_at, duration
       FROM clips WHERE user_id=$1 ORDER BY created_at DESC, id DESC`, [user.id]),
    q('SELECT platform, handle FROM channel_settings WHERE user_id=$1', [user.id]),
    q("SELECT channel, payload FROM jobs WHERE user_id=$1 AND status='error' ORDER BY id DESC", [user.id]),
  ]);
  const handleByPlat = {}; csR.rows.forEach((r) => { handleByPlat[r.platform] = r.handle; });
  const reasonByPlat = {};
  errR.rows.forEach((j) => { const pf = (j.channel || '').split(':')[0]; if (pf && reasonByPlat[pf] === undefined) reasonByPlat[pf] = (j.payload && j.payload.engine_error) || ''; });

  const posted = clipsR.rows.filter((c) => c.status === 'posted').length;
  const plan = user.plan;
  const atCap = plan === 'free' && posted >= 10;

  const clips = clipsR.rows.map((c) => ({
    id: String(c.id),
    title: c.title || c.source_title,
    description: c.description || '',
    sourceTitle: c.source_title,
    platform: c.platform,
    handle: handleByPlat[c.platform] || null,
    status: c.status,
    url: c.url || null,
    duration: c.duration || null,
    postedAt: c.posted_at,
    createdAt: c.created_at,
    reason: c.status === 'failed' ? (/daily|uploadlimit|youtube_channel_daily_limit/i.test(reasonByPlat[c.platform] || '') ? 'daily_limit' : 'other') : '',
    selectable: !!UPLOADABLE[c.status],
  }));

  res.status(200).json({ clips, plan, postedCount: posted, freeClipsLeft: Math.max(0, 10 - posted), atCap });
}

module.exports = async (req, res) => {
  if (!configured()) { res.status(200).json({ clips: [], plan: 'free', postedCount: 0, freeClipsLeft: 10, atCap: false }); return; }
  try {
    const user = await getUser(req);
    if (!user) { res.status(401).json({ error: 'unauthorized' }); return; }

    if (req.method === 'GET') { await listClips(user, res); return; }
    if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

    const b = req.body || {};
    const action = b.action;

    // ---- edit title/description ----
    if (action === 'edit') {
      const id = String(b.id || '');
      const cur = await q('SELECT id, status FROM clips WHERE id=$1 AND user_id=$2', [id, user.id]);
      if (!cur.rows.length) { res.status(404).json({ error: 'not_found' }); return; }
      const title = (b.title != null ? String(b.title) : '').slice(0, 200);
      const description = (b.description != null ? String(b.description) : '').slice(0, 5000);
      await q('UPDATE clips SET title=$1, description=$2 WHERE id=$3 AND user_id=$4', [title, description, id, user.id]);
      // a posted clip pushes the new title/description live via the engine
      if (cur.rows[0].status === 'posted') {
        await q("INSERT INTO jobs(user_id, type, payload, priority) VALUES ($1,'update_post',$2,80)", [user.id, JSON.stringify({ clip_id: id })]);
      }
      res.status(200).json({ ok: true });
      return;
    }

    // ---- delete a clip ----
    if (action === 'delete') {
      const id = String(b.id || '');
      const cur = await q('SELECT id, status FROM clips WHERE id=$1 AND user_id=$2', [id, user.id]);
      if (!cur.rows.length) { res.status(404).json({ error: 'not_found' }); return; }
      // a posted clip is taken down on the platform by the engine first
      if (cur.rows[0].status === 'posted') {
        await q("INSERT INTO jobs(user_id, type, payload, priority) VALUES ($1,'delete_post',$2,80)", [user.id, JSON.stringify({ clip_id: id })]);
      }
      await q('DELETE FROM clips WHERE id=$1 AND user_id=$2', [id, user.id]);
      res.status(200).json({ ok: true });
      return;
    }

    // ---- upload / retry (single or bulk) ----
    if (action === 'upload') {
      const ids = Array.isArray(b.ids) ? b.ids.map(String) : (b.id != null ? [String(b.id)] : []);
      if (!ids.length) { res.status(400).json({ error: 'bad_request' }); return; }
      const rows = (await q('SELECT id, status FROM clips WHERE user_id=$1 AND id = ANY($2::bigint[])', [user.id, ids])).rows;
      const byId = {}; rows.forEach((r) => { byId[String(r.id)] = r.status; });

      const plan = user.plan;
      let budget = plan !== 'free' ? Infinity : Math.max(0, 10 - (await postedCountFor(user.id)));
      const results = [];
      for (const id of ids) {
        const st = byId[id];
        if (!st || !UPLOADABLE[st]) { results.push({ id, result: 'skip' }); continue; }
        if (budget <= 0) { results.push({ id, result: 'capped' }); continue; }
        await q("UPDATE clips SET status='queued' WHERE id=$1 AND user_id=$2", [id, user.id]);
        await q("INSERT INTO jobs(user_id, type, payload, priority) VALUES ($1,'post_now',$2,90)", [user.id, JSON.stringify({ clip_id: id })]);
        budget -= 1;
        results.push({ id, result: 'queued' });
      }
      res.status(200).json({ ok: true, results, atCap: plan === 'free' && budget <= 0 });
      return;
    }

    res.status(400).json({ error: 'bad_action' });
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
};

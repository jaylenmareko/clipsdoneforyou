// POST /api/paddle/webhook — Paddle Billing webhook (raw-body signature verify).
// Mirrors the Stripe flow: subscription activation -> plan flip + banked-clip
// release; cancellation / past_due -> back to free; DFY one-time -> dfy_purchased.
//
// Body parsing is disabled (config at the bottom) so the exact bytes Paddle
// signed reach the HMAC check.
const crypto = require('crypto');
const { q, configured } = require('../_db');
const { planForPrice, PLAN_LABEL } = require('../_paddle');

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(typeof c === 'string' ? Buffer.from(c) : c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Paddle-Signature: "ts=<unix>;h1=<hmac sha256 of `${ts}:${rawBody}`>"
function verify(raw, header, secret) {
  if (!header) return false;
  const parts = {};
  String(header).split(';').forEach((kv) => { const i = kv.indexOf('='); if (i > 0) parts[kv.slice(0, i).trim()] = kv.slice(i + 1).trim(); });
  if (!parts.ts || !parts.h1) return false;
  const expected = crypto.createHmac('sha256', secret).update(parts.ts + ':' + raw.toString('utf8')).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.h1)); } catch (e) { return false; }
}

function firstPriceId(data) {
  const it = (data.items || [])[0];
  if (!it) return null;
  return (it.price && it.price.id) || it.price_id || null;
}

// free -> paid upgrade: release banked clips into the posting flow + confirm in
// chat + mark the journey so its own subscribe note doesn't double-post.
async function onUpgrade(userId, plan) {
  const banked = await q("SELECT id FROM clips WHERE user_id=$1 AND status='banked'", [userId]);
  for (const r of banked.rows) {
    await q("UPDATE clips SET status='queued' WHERE id=$1 AND user_id=$2", [r.id, userId]);
    await q("INSERT INTO jobs(user_id, type, payload, priority) VALUES ($1,'post_now',$2,90)", [userId, JSON.stringify({ clip_id: String(r.id) })]);
  }
  const label = PLAN_LABEL[plan] || plan;
  await q("INSERT INTO messages(user_id, role, text, conversation) VALUES ($1,'agent',$2,'all')",
    [userId, "You're on " + label + " — your banked clips are now posting."]);
  await q("UPDATE users SET journey = jsonb_set(coalesce(journey,'{}'::jsonb), '{subConfirmedPlan}', to_jsonb($1::text)) WHERE id=$2",
    [plan, userId]);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  const whSecret = process.env.PADDLE_WEBHOOK_SECRET;
  if (!whSecret || !configured()) { res.status(501).json({ error: 'not_configured' }); return; }

  let event;
  try {
    const raw = await readRaw(req);
    if (!verify(raw, req.headers['paddle-signature'], whSecret)) { res.status(400).json({ error: 'bad_signature' }); return; }
    event = JSON.parse(raw.toString('utf8'));
  } catch (e) {
    res.status(400).json({ error: 'bad_request' }); return;
  }

  try {
    const type = event.event_type || event.eventType;
    const data = event.data || {};
    const userId = (data.custom_data && (data.custom_data.user_id || data.custom_data.userId)) || null;
    const customerId = data.customer_id || null;
    const subId = data.id && String(type).indexOf('subscription') === 0 ? data.id : (data.subscription_id || null);

    if (type === 'subscription.activated' || type === 'subscription.created' || type === 'transaction.completed') {
      const plan = planForPrice(firstPriceId(data));
      if (userId && (plan === 'solo' || plan === 'multi')) {
        const cur = await q('SELECT plan FROM users WHERE id=$1', [userId]);
        const wasFree = !cur.rows.length || cur.rows[0].plan === 'free';
        await q('UPDATE users SET plan=$1, paddle_customer_id=$2, paddle_subscription_id=COALESCE($3, paddle_subscription_id), past_due=false WHERE id=$4',
          [plan, customerId, subId, userId]);
        if (wasFree) await onUpgrade(userId, plan);
      } else if (userId && plan === 'dfy') {
        // one-time Done-for-you purchase -> mark the account, no plan change
        await q('UPDATE users SET dfy_purchased=true, paddle_customer_id=COALESCE($1, paddle_customer_id) WHERE id=$2', [customerId, userId]);
      }
    } else if (type === 'subscription.canceled' || type === 'subscription.past_due') {
      if (subId) {
        await q("UPDATE users SET plan='free', paddle_subscription_id=NULL WHERE paddle_subscription_id=$1", [subId]);
      } else if (customerId) {
        await q("UPDATE users SET plan='free', paddle_subscription_id=NULL WHERE paddle_customer_id=$1", [customerId]);
      } else if (userId) {
        await q("UPDATE users SET plan='free', paddle_subscription_id=NULL WHERE id=$1", [userId]);
      }
    }
    res.status(200).json({ received: true });
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
};

// Disable Vercel's body parser so the exact bytes Paddle signed reach the HMAC.
module.exports.config = { api: { bodyParser: false } };

// POST /api/stripe/webhook — Stripe webhook (raw-body signature verification).
// Flips the user's plan on subscription activation, releases banked clips on a
// free -> paid upgrade, marks DFY purchases, reverts to free on cancellation,
// and marks past_due on a failed invoice (never deletes anything).
//
// Body parsing is disabled (config at the bottom) so the exact bytes Stripe
// signed reach constructEvent.
const { q, configured } = require('../_db');
const { planForPrice, PLAN_LABEL } = require('../_billing');

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(typeof c === 'string' ? Buffer.from(c) : c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Move a user's banked clips into the posting flow: queue each and enqueue a
// post_now job (same path the Upload button / engine use). Returns the count.
async function releaseBanked(userId) {
  const banked = await q("SELECT id FROM clips WHERE user_id=$1 AND status='banked'", [userId]);
  for (const r of banked.rows) {
    await q("UPDATE clips SET status='queued' WHERE id=$1 AND user_id=$2", [r.id, userId]);
    await q("INSERT INTO jobs(user_id, type, payload, priority) VALUES ($1,'post_now',$2,90)", [userId, JSON.stringify({ clip_id: String(r.id) })]);
  }
  return banked.rows.length;
}

// On a free -> paid upgrade: release banked clips, post the confirmation message,
// and mark the journey so its own subscribe note doesn't double-post.
async function onUpgrade(userId, plan) {
  await releaseBanked(userId);
  const label = PLAN_LABEL[plan] || plan;
  await q("INSERT INTO messages(user_id, role, text, conversation) VALUES ($1,'agent',$2,'all')",
    [userId, "You're on " + label + " — your banked clips are now posting."]);
  await q("UPDATE users SET journey = jsonb_set(coalesce(journey,'{}'::jsonb), '{subConfirmedPlan}', to_jsonb($1::text)) WHERE id=$2",
    [plan, userId]);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  const secret = process.env.STRIPE_SECRET_KEY;
  // Prefer the correctly-named var. The Vercel project also has a mis-typed
  // 'STRIPE_WEBHOOK_SECREt' (lowercase final t) that can't be renamed in place;
  // tolerate it until it's recreated correctly, then this fallback can be dropped.
  const whSecret = process.env.STRIPE_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECREt;
  if (!secret || !whSecret || !configured()) { res.status(501).json({ error: 'not_configured' }); return; }

  const stripe = require('stripe')(secret);
  let event;
  try {
    const raw = await readRaw(req);
    event = stripe.webhooks.constructEvent(raw, req.headers['stripe-signature'], whSecret);
  } catch (e) {
    res.status(400).json({ error: 'bad_signature' }); return;
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object;
      const userId = s.client_reference_id || (s.metadata && s.metadata.user_id);
      if (!userId) { res.status(200).json({ received: true }); return; }

      if (s.mode === 'subscription' && s.subscription) {
        // Match the plan by the subscription's price ID (not by trusting metadata).
        const sub = await stripe.subscriptions.retrieve(s.subscription);
        const priceId = sub.items && sub.items.data[0] && sub.items.data[0].price && sub.items.data[0].price.id;
        const plan = planForPrice(priceId);
        if (plan === 'solo' || plan === 'multi') {
          const cur = await q('SELECT plan FROM users WHERE id=$1', [userId]);
          const wasFree = !cur.rows.length || cur.rows[0].plan === 'free';
          await q('UPDATE users SET plan=$1, stripe_customer_id=$2, stripe_subscription_id=$3, past_due=false WHERE id=$4',
            [plan, s.customer || null, s.subscription, userId]);
          if (wasFree) await onUpgrade(userId, plan);
        }
      } else if (s.mode === 'payment') {
        // One-time DFY purchase -> mark dfy_purchased (match by the line item's price).
        const items = await stripe.checkout.sessions.listLineItems(s.id, { limit: 1 });
        const priceId = items.data[0] && items.data[0].price && items.data[0].price.id;
        if (planForPrice(priceId) === 'dfy') {
          await q('UPDATE users SET dfy_purchased=true, stripe_customer_id=$1 WHERE id=$2', [s.customer || null, userId]);
        }
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      if (sub.customer) {
        await q("UPDATE users SET plan='free', stripe_subscription_id=NULL WHERE stripe_customer_id=$1", [sub.customer]);
      }
    } else if (event.type === 'invoice.payment_failed') {
      const inv = event.data.object;
      if (inv.customer) {
        await q('UPDATE users SET past_due=true WHERE stripe_customer_id=$1', [inv.customer]);
      }
    }
    res.status(200).json({ received: true });
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
};

// Disable Vercel's body parser so the exact bytes Stripe signed reach
// constructEvent. Attached after the handler assignment so it isn't discarded.
module.exports.config = { api: { bodyParser: false } };

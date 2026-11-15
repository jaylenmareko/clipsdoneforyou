// POST /api/webhook — Stripe webhook. Flips the user's plan in the database on
// subscription activation, and back to free on cancellation. Verifies the
// signature against STRIPE_WEBHOOK_SECRET using the raw request body.
//
// Body parsing is disabled so the exact bytes Stripe signed reach constructEvent.
const { q, configured } = require('./_db');

module.exports.config = { api: { bodyParser: false } };

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(typeof c === 'string' ? Buffer.from(c) : c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  const secret = process.env.STRIPE_SECRET_KEY;
  const whSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !whSecret || !configured()) { res.status(501).json({ error: 'not_configured' }); return; }

  let event;
  try {
    const stripe = require('stripe')(secret);
    const raw = await readRaw(req);
    event = stripe.webhooks.constructEvent(raw, req.headers['stripe-signature'], whSecret);
  } catch (e) {
    res.status(400).json({ error: 'bad_signature' }); return;
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object;
      const userId = s.client_reference_id || (s.metadata && s.metadata.userId);
      const plan = s.metadata && s.metadata.plan;
      if (userId && plan) {
        await q('UPDATE users SET plan = $1, stripe_customer_id = $2 WHERE id = $3',
          [plan, s.customer || null, userId]);
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      if (sub.customer) {
        await q("UPDATE users SET plan = 'free' WHERE stripe_customer_id = $1", [sub.customer]);
      }
    }
    res.status(200).json({ received: true });
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
};

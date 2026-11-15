// POST /api/checkout  { plan }  (plan: "Solo" | "Multi" | "Done-for-you")
// Starts a real Stripe Checkout subscription session and returns its URL.
// If Stripe isn't configured yet, returns not_configured — the UI says so
// plainly rather than faking a plan change.
const { q, configured } = require('./_db');
const { getUser } = require('./_auth');

const PRICE_ENV = {
  Solo: 'STRIPE_PRICE_SOLO',
  Multi: 'STRIPE_PRICE_MULTI',
  'Done-for-you': 'STRIPE_PRICE_DFY',
};

function siteOrigin(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  if (!configured()) { res.status(501).json({ error: 'not_configured' }); return; }

  const secret = process.env.STRIPE_SECRET_KEY;
  const plan = req.body && req.body.plan;
  const priceEnv = PRICE_ENV[plan];
  const priceId = priceEnv ? process.env[priceEnv] : null;
  if (!secret || !priceId) { res.status(501).json({ error: 'not_configured' }); return; }

  try {
    const user = await getUser(req);
    if (!user) { res.status(401).json({ error: 'unauthorized' }); return; }

    const stripe = require('stripe')(secret);
    const origin = siteOrigin(req);
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: user.email,
      client_reference_id: user.id,
      metadata: { userId: user.id, plan },
      success_url: `${origin}/?billing=success`,
      cancel_url: `${origin}/?billing=cancelled`,
      allow_promotion_codes: true,
    });
    res.status(200).json({ url: session.url });
  } catch (e) {
    res.status(502).json({ error: 'stripe_error' });
  }
};

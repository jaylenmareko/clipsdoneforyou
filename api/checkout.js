// POST /api/checkout  { plan }  (plan: "Solo" | "Multi" | "Done-for-you")
// Starts a real Stripe Checkout session and returns its URL:
//   - Solo / Multi -> subscription mode
//   - Done-for-you -> payment mode (one-time $299)
// metadata.user_id carries the site user's id so the webhook can match the
// account. If Stripe isn't configured yet, returns not_configured — the UI
// says so plainly rather than faking a plan change.
const { configured } = require('./_db');
const { getUser } = require('./_auth');
const { PRICES, MODE } = require('./_billing');

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
  const priceId = PRICES[plan];
  const mode = MODE[plan];
  if (!secret || !priceId || !mode) { res.status(501).json({ error: 'not_configured' }); return; }

  try {
    const user = await getUser(req);
    if (!user) { res.status(401).json({ error: 'unauthorized' }); return; }

    const stripe = require('stripe')(secret);
    const origin = siteOrigin(req);
    const session = await stripe.checkout.sessions.create({
      mode,
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: user.email,
      client_reference_id: user.id,
      metadata: { user_id: user.id, plan },
      success_url: `${origin}/?billing=success#billing`,
      cancel_url: `${origin}/?billing=cancelled#billing`,
      allow_promotion_codes: true,
    });
    res.status(200).json({ url: session.url });
  } catch (e) {
    console.error('checkout_error:', e.message);
    res.status(502).json({ error: 'stripe_error', detail: e.message }); // TEMP: surface Stripe error for the live flip
  }
};

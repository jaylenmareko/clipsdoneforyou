// Shared Stripe billing config — price IDs and plan mapping, used by both
// checkout.js and stripe/webhook.js. Underscore-prefixed so it is a helper,
// not a Vercel serverless function (doesn't count toward the Hobby cap).
//
// These are the LIVE prices in the ClipsDoneForYou Stripe account (created by
// scripts/create-live-billing.js) — we never create prices here. Still
// overridable via env (STRIPE_PRICE_SOLO / _MULTI / _DFY) without touching this
// file; e.g. point back at the test prices in a test deployment.

const PRICES = {
  Solo: process.env.STRIPE_PRICE_SOLO || 'price_1UgCxPBLWv266p5wrHDcGzwT',       // $19/mo recurring (live)
  Multi: process.env.STRIPE_PRICE_MULTI || 'price_1UgCxQBLWv266p5wMMZfGslI',     // $39/mo recurring (live)
  'Done-for-you': process.env.STRIPE_PRICE_DFY || 'price_1UgCxQBLWv266p5wxQawzrnI', // $299 one-time (live)
};

// Checkout mode per plan: Solo/Multi are subscriptions, DFY is a one-time payment.
const MODE = { Solo: 'subscription', Multi: 'subscription', 'Done-for-you': 'payment' };

// The canonical plan string stored in users.plan (recurring plans only).
const PLAN_KEY = { Solo: 'solo', Multi: 'multi', 'Done-for-you': 'dfy' };

// Reverse: a price ID -> the plan we set, matched from the webhook event.
function planForPrice(priceId) {
  if (priceId === PRICES.Solo) return 'solo';
  if (priceId === PRICES.Multi) return 'multi';
  if (priceId === PRICES['Done-for-you']) return 'dfy';
  return null;
}

// Display label for a stored plan key (used in the chat confirmation message).
const PLAN_LABEL = { solo: 'Solo', multi: 'Multi', dfy: 'Done-for-you' };

module.exports = { PRICES, MODE, PLAN_KEY, PLAN_LABEL, planForPrice };

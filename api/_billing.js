// Shared Stripe billing config — price IDs and plan mapping, used by both
// checkout.js and stripe/webhook.js. Underscore-prefixed so it is a helper,
// not a Vercel serverless function (doesn't count toward the Hobby cap).
//
// These are the TEST-MODE prices that already exist in the ClipsDoneForYou
// Stripe sandbox — we never create prices here. For production, override via
// env (STRIPE_PRICE_SOLO / _MULTI / _DFY) without touching this file.

const PRICES = {
  Solo: process.env.STRIPE_PRICE_SOLO || 'price_1Ug9ThBLWv266p5wcjm5EurM',       // $19/mo recurring
  Multi: process.env.STRIPE_PRICE_MULTI || 'price_1Ug9TqBLWv266p5wsDX9mjGl',     // $39/mo recurring
  'Done-for-you': process.env.STRIPE_PRICE_DFY || 'price_1Ug9TuBLWv266p5wBAUDLk4M', // $299 one-time
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

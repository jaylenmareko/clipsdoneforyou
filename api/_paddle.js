// Shared Paddle Billing config — sandbox price IDs + plan mapping, used by the
// webhook and surfaced to the client (via /api/me) for Paddle.js checkout.
// Underscore-prefixed = helper, not a Vercel serverless function.
//
// These are the SANDBOX prices in the ClipsDoneForYou Paddle account
// (seller 164526, product pro_01m8fbgnej530ccv34dntdtap7). Override via env
// (PADDLE_PRICE_SOLO / _MULTI / _DFY) for production without touching this file.

const PRICES = {
  solo: process.env.PADDLE_PRICE_SOLO || 'pri_01m8fbh72keeb2h5jhrk2ak5gw',   // $19/mo recurring
  multi: process.env.PADDLE_PRICE_MULTI || 'pri_01m8fbhkety41msttjy5tw57rj',  // $39/mo recurring
  dfy: process.env.PADDLE_PRICE_DFY || 'pri_01m8fbj495cgxa6h03d7j2vvz6',      // $299 one-time
};

// price ID -> the plan we store (solo/multi recurring, dfy one-time)
function planForPrice(id) {
  if (id === PRICES.solo) return 'solo';
  if (id === PRICES.multi) return 'multi';
  if (id === PRICES.dfy) return 'dfy';
  return null;
}

const PLAN_LABEL = { solo: 'Solo', multi: 'Multi', dfy: 'Done-for-you' };

// client-side config handed to the browser for Paddle.js (token is not secret)
function clientConfig() {
  if (!process.env.PADDLE_CLIENT_TOKEN) return null;
  return {
    token: process.env.PADDLE_CLIENT_TOKEN,
    environment: process.env.PADDLE_ENV || 'sandbox',
    // keyed by the billing buttons' data-plan values
    prices: { Solo: PRICES.solo, Multi: PRICES.multi, 'Done-for-you': PRICES.dfy },
  };
}

module.exports = { PRICES, planForPrice, PLAN_LABEL, clientConfig };

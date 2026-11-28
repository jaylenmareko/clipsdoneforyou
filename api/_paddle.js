// Shared Paddle Billing config — sandbox price IDs + plan mapping, used by the
// webhook and surfaced to the client (via /api/me) for Paddle.js checkout.
// Underscore-prefixed = helper, not a Vercel serverless function.
//
// These are the LIVE prices in the ClipsDoneForYou Paddle account
// (seller 164526, live product pro_01m8ffx8cwxfe7y83g354vk2md). Override via env
// (PADDLE_PRICE_SOLO / _MULTI / _DFY) without touching this file; point back at
// the sandbox prices for local testing. Live keys/env live in Vercel.

const PRICES = {
  solo: process.env.PADDLE_PRICE_SOLO || 'pri_01m8ffxs9hdayrwdbx9m4xb7xk',   // $19/mo recurring (LIVE)
  multi: process.env.PADDLE_PRICE_MULTI || 'pri_01m8ffy210xgqnda92vxjenn20',  // $39/mo recurring (LIVE)
  dfy: process.env.PADDLE_PRICE_DFY || 'pri_01m8ffyhj7q7bcj7zt6cx9xq6q',      // $299 one-time (LIVE)
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

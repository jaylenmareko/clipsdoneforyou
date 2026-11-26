// Create the LIVE Stripe billing objects for ClipsDoneForYou.
//
// RUN THIS YOURSELF (not via Claude), with your LIVE secret key in the
// environment, so the key never leaves your machine:
//
//   STRIPE_SECRET_KEY=sk_live_xxx node scripts/create-live-billing.js
//
// or put the live key in .env.local as STRIPE_SECRET_KEY and run:
//
//   node scripts/create-live-billing.js
//
// Run it in your OWN terminal (not `! ...` inside Claude) so the printed
// webhook signing secret does NOT land in the chat transcript. The three
// price IDs are not secret and are safe to share.
//
// Idempotent: fixed idempotency keys mean re-running returns the SAME objects
// instead of creating duplicates.

const fs = require('fs');
['.env.local', '.env'].forEach((f) => {
  try {
    fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach((l) => {
      const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    });
  } catch (e) {}
});

const key = process.env.STRIPE_SECRET_KEY || '';
if (!key.startsWith('sk_live_')) {
  console.error('REFUSING: STRIPE_SECRET_KEY is not a LIVE key (must start with sk_live_). Got: ' + (key.slice(0, 8) || '(empty)') + '…');
  console.error('This script creates LIVE products/prices/webhook. Set your live key and re-run.');
  process.exit(1);
}
const stripe = require('stripe')(key);
const idem = (k) => ({ idempotencyKey: 'cdfy-live-' + k });

const PLANS = [
  { key: 'solo',  name: 'Solo',  unit_amount: 1900,  recurring: { interval: 'month' } },
  { key: 'multi', name: 'Multi', unit_amount: 3900,  recurring: { interval: 'month' } },
  { key: 'dfy',   name: 'DFY',   unit_amount: 29900, recurring: null }, // one-time
];

(async () => {
  const priceIds = {};
  for (const pl of PLANS) {
    const product = await stripe.products.create({ name: pl.name }, idem(pl.key + '-product'));
    const priceArgs = { product: product.id, currency: 'usd', unit_amount: pl.unit_amount };
    if (pl.recurring) priceArgs.recurring = pl.recurring;
    const price = await stripe.prices.create(priceArgs, idem(pl.key + '-price'));
    priceIds[pl.key] = price.id;
    console.log(pl.name + ': product ' + product.id + '  price ' + price.id + (pl.recurring ? ' (recurring $' + (pl.unit_amount / 100) + '/mo)' : ' (one-time $' + (pl.unit_amount / 100) + ')'));
  }

  const endpoint = await stripe.webhookEndpoints.create({
    url: 'https://www.clipsdoneforyou.com/api/stripe/webhook',
    enabled_events: ['checkout.session.completed', 'customer.subscription.deleted', 'invoice.payment_failed'],
    description: 'ClipsDoneForYou production',
  }, idem('webhook'));

  console.log('\n=========== SET THESE IN VERCEL (Production) ===========');
  console.log('STRIPE_PRICE_SOLO  = ' + priceIds.solo);
  console.log('STRIPE_PRICE_MULTI = ' + priceIds.multi);
  console.log('STRIPE_PRICE_DFY   = ' + priceIds.dfy);
  console.log('STRIPE_WEBHOOK_SECRET = ' + endpoint.secret + '   (secret — set in Vercel, do not paste in chat)');
  console.log('========================================================');
  console.log('\nAlso set in Vercel (Production): STRIPE_SECRET_KEY = your sk_live_... , NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = your pk_live_...');
  console.log('Share the three price_... IDs with Claude (not secret). Keep the webhook secret + keys to Vercel only.');
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });

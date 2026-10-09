// Run separately in test and live mode. This does not migrate subscriptions.
import { USAGE_PRICING } from '../containers/usage-policy.js';
const key = process.env.STRIPE_SECRET_KEY;
if (!key || (!process.argv.includes('--live') && !key.startsWith('sk_test_'))) {
  throw new Error('Set STRIPE_SECRET_KEY to a test key, or pass --live explicitly.');
}
async function create(path, fields, id) {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Stripe-Version': '2025-04-30.basil',
      'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': `mainbrella-usage-v1-${id}` },
    body: new URLSearchParams(fields), signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Stripe ${path}: HTTP ${response.status}`);
  return response.json();
}
const lookup = await fetch('https://api.stripe.com/v1/prices?lookup_keys[]=mainbrella_usage_minimum_v1', {
  headers: { Authorization: `Bearer ${key}`, 'Stripe-Version': '2025-04-30.basil' }, signal: AbortSignal.timeout(15000),
});
if (!lookup.ok) throw new Error(`Stripe price lookup: HTTP ${lookup.status}`);
const existing = (await lookup.json()).data[0];
if (existing) {
  if (!existing.active || existing.currency !== 'usd' || existing.unit_amount !== USAGE_PRICING.minimumCents
    || existing.recurring?.interval !== 'month' || existing.recurring?.interval_count !== 1
    || existing.recurring?.usage_type !== 'licensed') throw new Error('Existing usage minimum price does not match policy.');
  console.log(`STRIPE_USAGE_BASE_PRICE_ID=${existing.id}`);
} else {
  const productId = process.env.STRIPE_USAGE_PRODUCT_ID ?? (await create('products', { name: 'Mainbrella Usage' }, 'product')).id;
  const base = await create('prices', { product: productId, currency: 'usd', unit_amount: String(USAGE_PRICING.minimumCents),
    'recurring[interval]': 'month', 'recurring[usage_type]': 'licensed', lookup_key: 'mainbrella_usage_minimum_v1' }, 'base');
  console.log(`STRIPE_USAGE_BASE_PRICE_ID=${base.id}`);
}

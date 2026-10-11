import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { billingFixture, billingRequest, TEST_USER, TEST_CUSTOMER } from './billing-test-helpers';
import { handleDomainsRequest, reconcileDomainOrder, reconcileDomainOrders } from './domains';
import { domainName, namecom, usdCents } from '../lib/namecom';

const contact = { firstName: 'Alex', lastName: 'Example', email: 'alex@example.com', phone: '+14155552671',
  address1: '123 Main St', address2: '', city: 'San Francisco', state: 'CA', zip: '94103', country: 'US' };
async function fixture(t: TestContext) {
  const f = await billingFixture(t);
  for (const name of ['014_projects.sql','015_project_domain.sql','016_project_domains.sql','017_project_domain_provider.sql','037_domain_registrar.sql','038_domain_order_refunds.sql']) f.sqlite.exec(readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8'));
  Object.assign(f.env, { NAMECOM_ENABLED: 'true', NAME_DOT_COM_USERNAME: 'mainbrella', NAME_DOT_COM_TOKEN: 'fake_token', NAMECOM_MARKUP_BPS: '2000' });
  f.sqlite.prepare('INSERT INTO prepaid_accounts (user_id,stripe_customer_id,created_at) VALUES (?,?,?)').run(TEST_USER, TEST_CUSTOMER, Date.now());
  const state = { price: 10, renewal: 12, available: true, paid: false, premium: false, failCreate: 0, loseCreate: false,
    calls: [] as { url: URL; init?: RequestInit; body: any }[], creates: [] as { key: string; body: any }[], refunds: 0, charges: 0,
    sessions: new Map<string, any>(), claims: false, specialRequirements: false, mismatch: false };
  const domain = { domainName: 'example.com', expireDate: new Date(Date.now() + 365 * 86400000).toISOString(), privacyEnabled: true, locked: true,
    nameservers: ['ns1.name.com', 'ns2.name.com'], contacts: { registrant: { ...contact, isVerified: false, verificationId: 12 } } };
  f.state.override = async (url, init) => {
    const body = url.hostname.includes('name.com') && init?.body ? JSON.parse(String(init.body)) : new URLSearchParams(String(init?.body ?? ''));
    state.calls.push({ url, init, body });
    if (url.hostname.includes('name.com')) {
      if (url.pathname.endsWith(':search') || url.pathname.endsWith(':checkAvailability')) return Response.json({ results: [{ domainName: 'example.com', purchasable: state.available, purchaseType: 'registration', premium: state.premium, purchasePrice: state.price, renewalPrice: state.renewal }] });
      if (url.pathname.includes('/domaininfo/requirements/')) return Response.json({ tldInfo: { allowedRegistrationYears: [1,2,3,4,5,6,7,8,9,10] }, tldRequirements: { fields: state.specialRequirements ? { extra: {} } : {} } });
      if (url.pathname.includes('/domaininfo/claims/')) {
        if (init?.method !== 'POST') return Response.json({ message: 'method not allowed' }, { status: 405 });
        assert.deepEqual(body, { purchaseType: 'registration' });
        return Response.json({ domain: 'example.com', claims: [], claimId: state.claims ? 'claim' : null });
      }
      if (url.pathname.endsWith(':getPricing')) return Response.json({ premium: state.premium, purchasePrice: state.price * Number(url.searchParams.get('years') ?? 1), renewalPrice: state.renewal * Number(url.searchParams.get('years') ?? 1) });
      if (url.pathname === '/core/v1/domains' && init?.method === 'POST' || url.pathname.endsWith(':renew')) {
        state.creates.push({ key: new Headers(init?.headers).get('X-Idempotency-Key')!, body });
        if (state.loseCreate) { state.loseCreate = false; throw new Error('lost registrar response'); }
        if (state.failCreate) return Response.json({ message: 'registrar error' }, { status: state.failCreate });
        return Response.json({ domain, order: 123, totalPaid: state.price });
      }
      if (url.pathname.endsWith('/records') && !init?.method || url.pathname.endsWith('/records') && init?.method === 'GET') return Response.json({ records: [] });
      if (url.pathname === '/core/v1/domains/example.com') return Response.json(domain);
      return Response.json({});
    }
    if (url.pathname === '/v1/checkout/sessions' && init?.method === 'POST') {
      const fields = body as URLSearchParams, id = `cs_domain${state.sessions.size}`;
      const value = { id, client_secret: `${id}_secret`, customer: TEST_CUSTOMER, client_reference_id: TEST_USER, status: 'open',
        payment_status: 'unpaid', amount_total: Number(fields.get('line_items[0][price_data][unit_amount]')), currency: 'usd',
        metadata: { mainbrella_domain_order: fields.get('metadata[mainbrella_domain_order]') } };
      state.sessions.set(id, value); return Response.json(value);
    }
    if (url.pathname.startsWith('/v1/checkout/sessions/cs_domain')) {
      const session = state.sessions.get(url.pathname.split('/').at(-1)!);
      if (!session) return Response.json({}, { status: 404 });
      return Response.json({ ...session, status: state.paid ? 'complete' : session.status, payment_status: state.paid ? 'paid' : 'unpaid',
        payment_intent: state.paid ? { id: `pi_${session.id}`, payment_method: 'pm_card', customer: TEST_CUSTOMER, status: 'succeeded', currency: 'usd',
          amount_received: session.amount_total + (state.mismatch ? 1 : 0), latest_charge: { refunded: false, disputed: false, amount_refunded: 0 } } : null });
    }
    if (url.pathname.startsWith('/v1/payment_intents/pi_cs_domain')) return Response.json({ payment_method: 'pm_card' });
    if (url.pathname === '/v1/refunds') { state.refunds++; return Response.json({ id: 're_test', status: 'succeeded' }); }
    if (url.pathname === '/v1/payment_intents' && init?.method === 'POST') {
      state.charges++; return Response.json({ id: 'pi_auto', customer: TEST_CUSTOMER, currency: 'usd', status: 'succeeded', amount_received: Number((body as URLSearchParams).get('amount')), payment_method: 'pm_card' });
    }
    if (url.pathname === '/v1/payment_intents/pi_auto') return Response.json({ payment_method: 'pm_card' });
    return undefined;
  };
  const request = (path: string, body?: object, method = body ? 'POST' : 'GET') => handleDomainsRequest(billingRequest(`/domains${path}`, body, true, 'https://mainbrella.com', method), f.env);
  const quoted = async (years = 1) => { const response = await request('/quote', { domainName: 'example.com', years }); assert.equal(response.status,201); return (await response.json() as any).order; };
  const purchased = async () => { const order = await quoted(); const response = await request('/checkout', { orderId: order.id, contact, autoRenew: true, termsAccepted: true }); assert.equal(response.status,200); return order; };
  return { ...f, state, request, quoted, purchased };
}
test('refund migration preserves existing orders and reserves domains until refunds finish', async t => {
  const f = await billingFixture(t);
  for (const name of ['014_projects.sql', '037_domain_registrar.sql']) {
    f.sqlite.exec(readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8'));
  }
  const insert = f.sqlite.prepare(`INSERT INTO domain_orders
    (id,user_id,domain_name,kind,years,cost_cents,amount_cents,renewal_cents,premium,status,created_at,expires_at)
    VALUES (?,?,'example.com','registration',1,1000,1200,1440,0,?,1,2)`);
  insert.run('existing', TEST_USER, 'refunding');
  const before = f.sqlite.prepare('SELECT * FROM domain_orders WHERE id=?').get('existing');
  f.sqlite.exec(readFileSync(new URL('../../migrations/038_domain_order_refunds.sql', import.meta.url), 'utf8'));
  assert.deepEqual({ ...f.sqlite.prepare('SELECT * FROM domain_orders WHERE id=?').get('existing') }, { ...before, refund_id: null });
  f.sqlite.prepare('UPDATE domain_orders SET refund_id=? WHERE id=?').run('re_existing', 'existing');
  assert.equal((f.sqlite.prepare('SELECT refund_id FROM domain_orders WHERE id=?').get('existing') as any).refund_id, 're_existing');
  assert.throws(() => insert.run('competing', TEST_USER, 'checkout'), /UNIQUE constraint failed/);
  f.sqlite.prepare("UPDATE domain_orders SET status='refunded' WHERE id=?").run('existing');
  insert.run('competing', TEST_USER, 'checkout');
  assert.equal((f.sqlite.prepare('SELECT COUNT(*) AS count FROM domain_orders').get() as any).count, 2);
});
test('domain names exclude URLs, subdomains, IDNs, unsupported registries and invalid prices', () => {
  assert.equal(domainName('EXAMPLE.COM'), 'example.com');
  for (const name of ['https://example.com', 'www.example.com', 'xn--abc.com', 'example.ai', '-example.com', 'example.com/path']) assert.equal(domainName(name), null);
  assert.equal(usdCents(12.99),1299); for (const value of [-1,0,NaN,Infinity,12.999,null]) assert.throws(() => usdCents(value));
});
test('local credentials always target sandbox with the test username and preserve action colons', async t => {
  const f = await fixture(t); f.env.LOCAL_DEV = 'true';
  await namecom(f.env,'/domains:search','POST',{ keyword:'example' });
  const call = f.state.calls.at(-1)!; assert.equal(call.url.hostname,'api.dev.name.com'); assert.equal(call.url.pathname,'/core/v1/domains:search');
  assert.equal(new Headers(call.init?.headers).get('authorization'),`Basic ${btoa('mainbrella-test:fake_token')}`);
});
test('search prices include configured markup; premium multi-year quotes use authoritative totals and annual renewal', async t => {
  const f = await fixture(t); f.state.premium = true;
  const response = await f.request('/search',{keyword:'example'}); assert.equal(response.status,200);
  assert.equal((await response.json() as any).results[0].amountCents,1200);
  const quote = await f.quoted(3); assert.equal(quote.amountCents,3600); assert.equal(quote.renewalCents,1440); assert.equal(quote.premium,true);
});
test('quotes and checkout recheck domain claims with the registration request', async t => {
  const f = await fixture(t);
  const order = await f.quoted();
  const checkout = await f.request('/checkout',{orderId:order.id,contact,autoRenew:true,termsAccepted:true});
  assert.equal(checkout.status,200);
  const claimsCalls = f.state.calls.filter(call => call.url.pathname === '/core/v1/domaininfo/claims/example.com');
  assert.equal(claimsCalls.length,2);
  for (const call of claimsCalls) {
    assert.equal(call.init?.method,'POST');
    assert.deepEqual(call.body,{ purchaseType:'registration' });
  }
});
test('rejects unsupported registration requirements and trademark claims before payment', async t => {
  const f = await fixture(t); f.state.claims = true;
  assert.equal((await f.request('/quote',{domainName:'example.com',years:1})).status,400);
  assert.equal(f.state.sessions.size,0);
  f.state.claims = false; f.state.specialRequirements = true;
  assert.equal((await f.request('/quote',{domainName:'example.com',years:1})).status,400); assert.equal(f.state.sessions.size,0);
});
test('checkout enforces contact details, consent, current price and idempotent resumption', async t => {
  const f = await fixture(t), order = await f.quoted();
  assert.equal((await f.request('/checkout',{orderId:order.id,autoRenew:true,termsAccepted:false})).status,400);
  assert.equal((await f.request('/checkout',{orderId:order.id,autoRenew:true,termsAccepted:true})).status,400);
  f.state.price=11; assert.equal((await f.request('/checkout',{orderId:order.id,contact,autoRenew:true,termsAccepted:true})).status,409); assert.equal(f.state.sessions.size,0);
  f.state.price=10;
  for (let i=0;i<2;i++) assert.equal((await f.request('/checkout',{orderId:order.id,contact,autoRenew:true,termsAccepted:true})).status,200);
  assert.equal(f.state.sessions.size,1);
  const fields=f.state.calls.find(c=>c.url.pathname==='/v1/checkout/sessions'&&c.init?.method==='POST')!.body as URLSearchParams;
  assert.equal(fields.get('payment_intent_data[setup_future_usage]'),'off_session'); assert.equal(fields.get('line_items[0][price_data][unit_amount]'),'1200');
});
test('unpaid or mismatched payments cannot register; verified payment registers end-user contacts with privacy and registrar auto-renew off', async t => {
  const f=await fixture(t), order=await f.purchased();
  await reconcileDomainOrder(f.env,order.id); assert.equal(f.state.creates.length,0);
  f.state.paid=true; f.state.mismatch=true; const mismatch=await reconcileDomainOrder(f.env,order.id); assert.equal(mismatch.error,'payment_mismatch'); assert.equal(f.state.creates.length,0);
  f.state.mismatch=false; const completed=await reconcileDomainOrder(f.env,order.id); assert.equal(completed.status,'complete'); assert.equal(f.state.creates.length,1);
  assert.deepEqual(f.state.creates[0].body.domain.contacts.registrant,contact); assert.equal(f.state.creates[0].body.domain.privacyEnabled,true); assert.equal(f.state.creates[0].body.domain.autorenewEnabled,false);
  await reconcileDomainOrder(f.env,order.id); assert.equal(f.state.creates.length,1);
  const registration=f.sqlite.prepare('SELECT * FROM domain_registrations').get() as any; assert.equal(registration.user_id,TEST_USER); assert.equal(registration.auto_renew,1);
});
test('availability races and definitive registrar rejection refund once', async t => {
  const f=await fixture(t), order=await f.purchased(); f.state.paid=true; f.state.available=false;
  assert.equal((await reconcileDomainOrder(f.env,order.id)).status,'refunded'); assert.equal(f.state.refunds,1); assert.equal(f.state.creates.length,0);
  await reconcileDomainOrder(f.env,order.id); assert.equal(f.state.refunds,1);
});
test('lost registrar responses retry the stored request and key without a second availability check or refund', async t => {
  const f=await fixture(t), order=await f.purchased(); f.state.paid=true; f.state.loseCreate=true;
  assert.equal((await reconcileDomainOrder(f.env,order.id)).status,'fulfilling'); assert.equal(f.state.refunds,0);
  f.state.available=false;
  assert.equal((await reconcileDomainOrder(f.env,order.id)).status,'complete'); assert.equal(f.state.creates.length,2);
  assert.equal(f.state.creates[0].key,f.state.creates[1].key); assert.deepEqual(f.state.creates[0].body,f.state.creates[1].body);
});
test('definitive registrar rejection refunds while ambiguous provider errors retain the reservation', async t => {
  const f=await fixture(t), order=await f.purchased(); f.state.paid=true; f.state.failCreate=500;
  assert.equal((await reconcileDomainOrder(f.env,order.id)).status,'fulfilling'); assert.equal(f.state.refunds,0);
  f.state.failCreate=400;
  assert.equal((await reconcileDomainOrder(f.env,order.id)).status,'refunded'); assert.equal(f.state.refunds,1);
  await reconcileDomainOrder(f.env,order.id); assert.equal(f.state.refunds,1);
});
test('order leases fence concurrent fulfillment and competing checkouts cannot reserve the same domain', async t => {
  const f=await fixture(t), order=await f.purchased(); f.state.paid=true;
  const other=await f.quoted(); assert.equal((await f.request('/checkout',{orderId:other.id,contact,autoRenew:true,termsAccepted:true})).status,409);
  f.sqlite.prepare('UPDATE domain_orders SET lease_until=? WHERE id=?').run(Date.now()+60000,order.id);
  assert.equal((await reconcileDomainOrder(f.env,order.id)).status,'checkout'); assert.equal(f.state.creates.length,0);
  f.sqlite.prepare('UPDATE domain_orders SET lease_until=0 WHERE id=?').run(order.id);
  await Promise.all([reconcileDomainOrder(f.env,order.id),reconcileDomainOrder(f.env,order.id)]);
  assert.equal(f.state.creates.length,1);
});
test('stale ambiguous purchases enter review and retain the domain reservation', async t => {
  const f=await fixture(t), order=await f.purchased(); f.state.paid=true; f.state.loseCreate=true;
  await reconcileDomainOrder(f.env,order.id); f.sqlite.prepare('UPDATE domain_orders SET created_at=? WHERE id=?').run(Date.now()-25*3600000,order.id);
  assert.equal((await reconcileDomainOrder(f.env,order.id)).status,'review'); assert.equal(f.state.creates.length,1); assert.equal(f.state.refunds,0);
});
test('ownership, origin and authentication checks precede registrar mutations', async t => {
  const f=await fixture(t), order=await f.quoted();
  f.sqlite.prepare("INSERT INTO users (id,email,name) VALUES ('other','other@example.com','Other')").run();
  f.sqlite.prepare("UPDATE domain_orders SET user_id='other' WHERE id=?").run(order.id);
  assert.equal((await f.request(`/order?id=${order.id}`)).status,404);
  assert.equal((await f.request('/checkout',{orderId:order.id,contact,autoRenew:false,termsAccepted:true})).status,404);
  assert.equal((await f.request('/detail?domainName=example.com')).status,404);
  assert.equal((await handleDomainsRequest(billingRequest('/domains/search',{keyword:'example'},false),f.env)).status,401);
  assert.equal((await handleDomainsRequest(billingRequest('/domains/search',{keyword:'example'},true,null),f.env)).status,403);
  assert.equal(f.state.creates.length,0);
});
test('scheduled renewals charge before registrar renewal and require fresh approval for price increases', async t => {
  const f=await fixture(t), order=await f.purchased(); f.state.paid=true; await reconcileDomainOrder(f.env,order.id);
  const nearExpiry=new Date(Date.now()+20*86400000).toISOString(); f.sqlite.prepare('UPDATE domain_registrations SET expire_date=?').run(nearExpiry);
  f.state.renewal=13; await reconcileDomainOrders(f.env); assert.equal(f.state.charges,0);
  assert.equal((f.sqlite.prepare('SELECT error FROM domain_registrations').get() as any).error,'renewal_price_changed');
  f.state.renewal=12; f.sqlite.prepare('UPDATE domain_registrations SET error=NULL').run();
  await reconcileDomainOrders(f.env); assert.equal(f.state.charges,1); assert.equal(f.state.creates.length,2);
  const calls=f.state.calls.map(c=>c.url.pathname); assert.ok(calls.indexOf('/v1/payment_intents')<calls.indexOf('/core/v1/domains/example.com:renew'));
  await reconcileDomainOrders(f.env); assert.equal(f.state.charges,1);
});
test('checkout expiration releases reservation without registering; local live Stripe keys are rejected', async t => {
  const f=await fixture(t), order=await f.purchased(); f.state.sessions.values().next().value!.status='expired';
  assert.equal((await reconcileDomainOrder(f.env,order.id)).status,'expired'); assert.equal(f.state.creates.length,0);
  f.env.LOCAL_DEV='true'; f.env.STRIPE_SECRET_KEY='sk_live_fake';
  assert.equal((await f.request('/config').then(r=>r.json()) as any).configured,false);
});

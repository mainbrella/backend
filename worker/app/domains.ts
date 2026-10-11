import { z } from 'zod';
import { authCorsHeaders, authJson, currentUser, type AuthUser } from './auth-core';
import { boundedPrivateBody } from '../../containers/private-services-contract.js';
import { stripeRequest, type BillingEnv } from '../lib/stripe';
import { ensurePrepaidAccount } from '../lib/prepaid-billing';
import { namecom, DomainError, DOMAIN_TLDS, domainName, registrarConfigured, retailCents, usdCents, nameDomainPath, checkedNameDomain, type NameDomain, type NameRecord } from '../lib/namecom';
import { apexIps, customDomainsConfigured } from '../lib/project-hosting';
import { purchasedProjectDomain, disconnectPurchasedDomain } from './project-hosting';
import { contactSchema, quoteSchema, checkoutSchema, settingsSchema, recordSchema } from './domain-schemas';

export interface DomainOrder {
  id: string; user_id: string; project_id: string | null; domain_name: string; kind: 'registration' | 'renewal'; years: number;
  cost_cents: number; amount_cents: number; renewal_cents: number; premium: number; auto_renew: number;
  contact_json: string | null; terms_accepted_at: number | null; customer_id: string | null; checkout_id: string | null;
  payment_intent_id: string | null; refund_id: string | null; status: string; error: string | null; provider_order: string | null;
  lease_until: number; created_at: number; expires_at: number; dns_revision: string | null;
}
interface Registration {
  domain_name: string; user_id: string; project_id: string | null; expire_date: string; auto_renew: number;
  renewal_cents: number; customer_id: string; payment_method_id: string | null; error: string | null;
}
interface SearchResult { domainName: string; purchasable: boolean; purchaseType?: string; premium?: boolean; purchasePrice?: number; renewalPrice?: number }
interface Session {
  id: string; client_secret?: string; customer: string; client_reference_id: string; status: string;
  payment_status: string; amount_total: number; currency: string; metadata: Record<string, string>;
  payment_intent: string | { id: string; payment_method: string; status: string; amount_received: number; currency: string; customer: string; latest_charge?: { refunded: boolean; disputed: boolean; amount_refunded: number } };
}
const terminal = new Set(['complete', 'refunded', 'expired']);
const orderFor = (env: Env, id: string) => env.DB.prepare('SELECT * FROM domain_orders WHERE id = ?').bind(id).first<DomainOrder>();
const ownedRegistration = async (env: Env, name: string, userId: string) => {
  const value = await env.DB.prepare('SELECT * FROM domain_registrations WHERE domain_name = ? AND user_id = ?').bind(name, userId).first<Registration>();
  if (!value) throw new DomainError('not_found', 404);
  return value;
};
export const publicOrder = (order: DomainOrder) => ({ id: order.id, domainName: order.domain_name, projectId: order.project_id,
  kind: order.kind, years: order.years, amountCents: order.amount_cents, renewalCents: order.renewal_cents,
  premium: Boolean(order.premium), autoRenew: Boolean(order.auto_renew), status: order.status, error: order.error, expiresAt: order.expires_at });
async function parseBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  try { return schema.parse(JSON.parse(new TextDecoder().decode(await boundedPrivateBody(request.body, 16384)))); }
  catch { throw new DomainError('invalid_request', 400); }
}
function billingReady(env: BillingEnv): boolean {
  return registrarConfigured(env) && Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_PUBLISHABLE_KEY)
    && (env.LOCAL_DEV !== 'true' || env.STRIPE_SECRET_KEY!.startsWith('sk_test_') && env.STRIPE_PUBLISHABLE_KEY!.startsWith('pk_test_'));
}
async function registrationChecks(env: Env, name: string, years: number) {
  const result = await namecom<{ results: SearchResult[] }>(env, '/domains:checkAvailability', 'POST', { domainNames: [name], purchaseType: 'registration' });
  const match = result.results?.find(value => value.domainName === name);
  if (!match?.purchasable || match.purchaseType !== 'registration') throw new DomainError('domain_unavailable', 409, true);
  const requirements = await namecom<{ tldInfo: { allowedRegistrationYears: number[] }; tldRequirements?: { fields?: Record<string, unknown> } }>(env, `/domaininfo/requirements/${name.split('.')[1]}`);
  if (!requirements.tldInfo?.allowedRegistrationYears?.includes(years) || Object.keys(requirements.tldRequirements?.fields ?? {}).length) throw new DomainError('domain_unsupported', 400, true);
  const claims = await namecom<{ claims: unknown[]; claimId?: string | null }>(env, `/domaininfo/claims/${name}`);
  if (!Array.isArray(claims.claims) || claims.claims.length || claims.claimId) throw new DomainError('domain_claims_unsupported', 400, true);
}
async function pricing(env: Env, name: string, years: number, kind: string) {
  if (kind === 'registration') await registrationChecks(env, name, years);
  const price = await namecom<{ purchasePrice: number | null; renewalPrice: number | null; premium: boolean }>(env, `${nameDomainPath(name)}:getPricing?years=${years}`);
  const annual = years === 1 ? price : await namecom<{ renewalPrice: number | null }>(env, `${nameDomainPath(name)}:getPricing?years=1`);
  const cost = usdCents(kind === 'registration' ? price.purchasePrice : price.renewalPrice);
  return { cost, amount: retailCents(env, cost), renewal: retailCents(env, usdCents(annual.renewalPrice)), premium: price.premium === true };
}
async function quote(env: Env, user: AuthUser, value: z.infer<typeof quoteSchema>) {
  const name = domainName(value.domainName);
  if (!name) throw new DomainError('domain_unsupported', 400);
  if (value.projectId && !await env.DB.prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?').bind(value.projectId, user.id).first()) throw new DomainError('not_found', 404);
  if (value.projectId && (env.LOCAL_DEV === 'true' || !customDomainsConfigured(env))) throw new DomainError('domain_connection_unavailable', 503);
  if (value.kind === 'renewal') await ownedRegistration(env, name, user.id);
  else if (await env.DB.prepare('SELECT domain_name FROM domain_registrations WHERE domain_name = ?').bind(name).first()) throw new DomainError('domain_unavailable', 409);
  const price = await pricing(env, name, value.years, value.kind);
  const id = crypto.randomUUID(), now = Date.now();
  await env.DB.prepare(`INSERT INTO domain_orders (id,user_id,project_id,domain_name,kind,years,cost_cents,amount_cents,renewal_cents,premium,created_at,expires_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, user.id, value.projectId ?? null, name, value.kind, value.years, price.cost, price.amount, price.renewal, Number(price.premium), now, now + 15 * 60000).run();
  return (await orderFor(env, id))!;
}
async function checkout(env: BillingEnv, user: AuthUser, request: Request, input: z.infer<typeof checkoutSchema>) {
  if (!billingReady(env)) throw new DomainError('billing_unavailable');
  let order = await orderFor(env, input.orderId);
  if (!order || order.user_id !== user.id) throw new DomainError('not_found', 404);
  if (order.status === 'quoted') {
    if (order.expires_at < Date.now()) throw new DomainError('quote_expired', 409);
    if (order.kind === 'registration' && !input.contact) throw new DomainError('contact_required', 400);
    const price = await pricing(env, order.domain_name, order.years, order.kind);
    if (price.cost !== order.cost_cents || price.amount !== order.amount_cents || price.renewal !== order.renewal_cents) throw new DomainError('price_changed', 409);
    const account = await ensurePrepaidAccount(env, user);
    try {
      await env.DB.prepare(`UPDATE domain_orders SET status='checkout', customer_id=?, contact_json=?, auto_renew=?, terms_accepted_at=?
        WHERE id=? AND status='quoted'`).bind(account.stripe_customer_id, input.contact ? JSON.stringify(input.contact) : null, Number(input.autoRenew), Date.now(), order.id).run();
    } catch { throw new DomainError('domain_order_pending', 409); }
    order = (await orderFor(env, order.id))!;
  }
  if (order.status !== 'checkout') return { order: publicOrder(order) };
  // Stripe keys last 24h. Do not recreate a session with an expired key after a
  // lost response; the original payment needs operator reconciliation instead.
  if (!order.checkout_id && Date.now() - order.created_at > 23 * 3600000) throw new DomainError('order_review_required', 409);
  const fields = new URLSearchParams({ mode: 'payment', ui_mode: 'custom', customer: order.customer_id!, client_reference_id: user.id,
    'payment_method_types[0]': 'card', billing_address_collection: 'required',
    'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][unit_amount]': String(order.amount_cents),
    'line_items[0][price_data][product_data][name]': `${order.domain_name} — ${order.years} year ${order.kind}`, 'line_items[0][quantity]': '1',
    'metadata[mainbrella_domain_order]': order.id, 'payment_intent_data[metadata][mainbrella_domain_order]': order.id,
    'payment_intent_data[setup_future_usage]': 'off_session',
    return_url: `${new URL(request.headers.get('Origin')!).origin}/projects/?domainOrder=${order.id}`,
  });
  const session = order.checkout_id ? await stripeRequest<Session>(env, `/checkout/sessions/${order.checkout_id}`)
    : await stripeRequest<Session>(env, '/checkout/sessions', fields, `domain-checkout-${order.id}`);
  if (!/^cs_[A-Za-z0-9_]+$/.test(session.id) || session.customer !== order.customer_id || session.metadata?.mainbrella_domain_order !== order.id) throw new DomainError('payment_mismatch');
  await env.DB.prepare('UPDATE domain_orders SET checkout_id=? WHERE id=? AND status=\'checkout\'').bind(session.id, order.id).run();
  if (session.status === 'expired') { await env.DB.prepare("UPDATE domain_orders SET status='expired' WHERE id=? AND status='checkout'").bind(order.id).run(); throw new DomainError('checkout_expired', 409); }
  return { order: publicOrder(order), clientSecret: session.client_secret, publishableKey: env.STRIPE_PUBLISHABLE_KEY };
}
async function refund(env: BillingEnv, order: DomainOrder, reason: string) {
  if (!order.payment_intent_id) throw new DomainError('payment_mismatch');
  await env.DB.prepare("UPDATE domain_orders SET status='refunding', error=? WHERE id=?").bind(reason, order.id).run();
  const result = order.refund_id ? await stripeRequest<{ id: string; status: string }>(env, `/refunds/${order.refund_id}`)
    : await stripeRequest<{ id: string; status: string }>(env, '/refunds', new URLSearchParams({ payment_intent: order.payment_intent_id, amount: String(order.amount_cents) }), `domain-refund-${order.id}`);
  if (!/^re_[A-Za-z0-9_]+$/.test(result.id)) throw new DomainError('billing_unavailable');
  await env.DB.prepare('UPDATE domain_orders SET refund_id=? WHERE id=?').bind(result.id, order.id).run();
  if (result.status === 'succeeded') await env.DB.prepare("UPDATE domain_orders SET status='refunded',contact_json=NULL WHERE id=?").bind(order.id).run();
  else if (['failed','canceled'].includes(result.status)) await env.DB.prepare("UPDATE domain_orders SET status='review',error='refund_failed' WHERE id=?").bind(order.id).run();
}
async function connect(env: Env, order: DomainOrder) {
  if (!order.project_id) return;
  if (!await env.DB.prepare('SELECT id FROM projects WHERE id=? AND user_id=?').bind(order.project_id, order.user_id).first()) return;
  for (const hostname of [order.domain_name, `www.${order.domain_name}`]) {
    const domain = await purchasedProjectDomain(env, order.project_id, order.user_id, hostname);
    const records = await namecom<{ records: NameRecord[] }>(env, `${nameDomainPath(order.domain_name)}/records`);
    const desired = domain.dnsRecords.filter(r => r.purpose !== 'routing');
    const routing = hostname === order.domain_name && apexIps(env).length ? domain.apexRecords ?? [] : domain.dnsRecords.filter(r => r.purpose === 'routing')
      .map(r => ({ ...r, type: hostname === order.domain_name && r.type === 'CNAME' ? 'ANAME' : r.type }));
    if (!routing.length) throw new DomainError('domain_connection_pending');
    for (const record of [...desired, ...routing]) {
      const host = record.name === order.domain_name ? '' : record.name.replace(new RegExp(`\\.${order.domain_name.replaceAll('.', '\\.')}\\.?$`), '');
      if (records.records?.some(r => r.type === record.type && (r.host ?? '') === host && r.answer === record.value)) continue;
      // Switching an owned domain to a new project replaces only MainBrella's
      // ownership and website routing records; mail and other TXT records survive.
      for (const prior of records.records ?? []) {
        if ((prior.host ?? '') !== host) continue;
        if (record.purpose === 'ownership' && prior.type === 'TXT' && prior.answer.startsWith('mainbrella-verification=')
          || record.purpose === 'routing' && ['A','AAAA','CNAME','ANAME'].includes(prior.type)
            && !routing.some(r => r.type === prior.type && r.value === prior.answer)) {
          await namecom(env, `${nameDomainPath(order.domain_name)}/records/${prior.id}`, 'DELETE');
        }
      }
      const payload = { type: record.type, host, answer: record.value, ttl: 300 };
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(payload)));
      const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2,'0')).join('').slice(0,24);
      await namecom(env, `${nameDomainPath(order.domain_name)}/records`, 'POST', payload, `domain-dns-${order.dns_revision ?? order.id}-${hash}`);
    }
    const verified = await purchasedProjectDomain(env, order.project_id, order.user_id, hostname, true);
    if (verified.status !== 'active') throw new DomainError('domain_connection_pending');
  }
}
export async function reconcileDomainOrder(env: BillingEnv, id: string): Promise<DomainOrder> {
  let order = await orderFor(env, id);
  if (!order) throw new DomainError('not_found', 404);
  if (terminal.has(order.status) || order.status === 'quoted' || order.status === 'review') return order;
  const claimed = await env.DB.prepare('UPDATE domain_orders SET lease_until=? WHERE id=? AND lease_until < ?').bind(Date.now() + 300000, id, Date.now()).run();
  if (!claimed.meta.changes) return order;
  try {
    if (order.status === 'charging') {
      const registration = await ownedRegistration(env, order.domain_name, order.user_id);
      if (Date.now() - order.created_at > 23 * 3600000) {
        await env.DB.prepare("UPDATE domain_orders SET status='review',error='order_review_required' WHERE id=?").bind(id).run();
        return (await orderFor(env, id))!;
      }
      const params = new URLSearchParams({ customer: order.customer_id!, payment_method: registration.payment_method_id!,
        amount: String(order.amount_cents), currency: 'usd', confirm: 'true', off_session: 'true',
        description: `${order.domain_name} — annual renewal`, 'metadata[mainbrella_domain_order]': id });
      const intent = order.payment_intent_id ? await stripeRequest<{ id: string; status: string; amount_received: number; customer: string; currency: string }>(env, `/payment_intents/${order.payment_intent_id}`)
        : await stripeRequest<{ id: string; status: string; amount_received: number; customer: string; currency: string }>(env, '/payment_intents', params, `domain-auto-renew-${id}`);
      await env.DB.prepare('UPDATE domain_orders SET payment_intent_id=? WHERE id=?').bind(intent.id, id).run();
      if (intent.status !== 'succeeded') {
        await env.DB.prepare("UPDATE domain_registrations SET error='renewal_payment_failed' WHERE domain_name=?").bind(order.domain_name).run();
        return (await orderFor(env, id))!;
      }
      if (intent.customer !== order.customer_id || intent.currency !== 'usd' || intent.amount_received !== order.amount_cents) throw new DomainError('payment_mismatch');
      await env.DB.prepare("UPDATE domain_orders SET status='paid' WHERE id=?").bind(id).run();
      order = (await orderFor(env, id))!;
    }
    if (order.status === 'checkout') {
      if (!order.checkout_id) return order;
      const session = await stripeRequest<Session>(env, `/checkout/sessions/${order.checkout_id}?expand[]=payment_intent.latest_charge`);
      if (session.status === 'expired') { await env.DB.prepare("UPDATE domain_orders SET status='expired' WHERE id=?").bind(id).run(); return (await orderFor(env, id))!; }
      if (session.status !== 'complete' || session.payment_status !== 'paid') return order;
      const intent = typeof session.payment_intent === 'object' ? session.payment_intent : null;
      if (session.customer !== order.customer_id || session.client_reference_id !== order.user_id || session.metadata?.mainbrella_domain_order !== id
        || session.currency !== 'usd' || session.amount_total !== order.amount_cents || !intent || intent.customer !== order.customer_id
        || intent.status !== 'succeeded' || intent.currency !== 'usd' || intent.amount_received !== order.amount_cents
        || !intent.latest_charge || intent.latest_charge.disputed || intent.latest_charge.refunded || intent.latest_charge.amount_refunded) throw new DomainError('payment_mismatch');
      await env.DB.prepare("UPDATE domain_orders SET status='paid',payment_intent_id=? WHERE id=?").bind(intent.id, id).run();
      order = (await orderFor(env, id))!;
    }
    if (order.status === 'refunding') { await refund(env, order, order.error ?? 'registration_failed'); return (await orderFor(env, id))!; }
    if (['paid', 'fulfilling'].includes(order.status)) {
      if (!order.terms_accepted_at) throw new DomainError('payment_mismatch');
      // Fresh precheck only before the first billable attempt. Retries send exactly
      // the stored body and key; a domain becoming unavailable is expected after success.
      if (order.status === 'paid') {
        try {
          const price = await pricing(env, order.domain_name, order.years, order.kind);
          if (price.cost !== order.cost_cents) { await refund(env, order, 'price_changed'); return (await orderFor(env, id))!; }
        } catch (error) {
          if (error instanceof DomainError && error.definitive) { await refund(env, order, error.message); return (await orderFor(env, id))!; }
          throw error;
        }
        await env.DB.prepare("UPDATE domain_orders SET status='fulfilling' WHERE id=?").bind(id).run();
      }
      // Conservatively fence stale ambiguous registrar requests, whose key retention
      // is provider controlled. Never attribute existing reseller inventory to a user.
      if (Date.now() - order.created_at > 23 * 3600000) {
        await env.DB.prepare("UPDATE domain_orders SET status='review',error='order_review_required' WHERE id=?").bind(id).run();
        return (await orderFor(env, id))!;
      }
      const contact = order.contact_json ? contactSchema.parse(JSON.parse(order.contact_json)) : undefined;
      let result: { domain: NameDomain; order: number };
      try {
        result = await namecom(env, order.kind === 'registration' ? '/domains' : `${nameDomainPath(order.domain_name)}:renew`, 'POST',
          order.kind === 'registration' ? { domain: { domainName: order.domain_name, autorenewEnabled: false, privacyEnabled: true, locked: true,
            contacts: { registrant: contact, admin: contact, billing: contact, tech: contact } }, purchaseType: 'registration', years: order.years, purchasePrice: order.cost_cents / 100 }
            : { years: order.years, purchasePrice: order.cost_cents / 100 }, `domain-register-${id}`);
      } catch (error) {
        if (error instanceof DomainError && error.definitive) { await refund(env, order, 'registration_failed'); return (await orderFor(env, id))!; }
        throw error;
      }
      const domain = checkedNameDomain(result.domain, order.domain_name);
      const intent = await stripeRequest<{ payment_method: string }>(env, `/payment_intents/${order.payment_intent_id}`);
      await env.DB.prepare(`INSERT INTO domain_registrations (domain_name,user_id,project_id,expire_date,auto_renew,renewal_cents,payment_method_id,customer_id,created_at)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(domain_name) DO UPDATE SET expire_date=excluded.expire_date,auto_renew=excluded.auto_renew,
        renewal_cents=excluded.renewal_cents,payment_method_id=excluded.payment_method_id,error=NULL WHERE domain_registrations.user_id=excluded.user_id`)
        .bind(order.domain_name, order.user_id, order.project_id, domain.expireDate, order.auto_renew, order.renewal_cents, intent.payment_method, order.customer_id, Date.now()).run();
      await env.DB.prepare("UPDATE domain_orders SET status='registered',provider_order=?,contact_json=NULL,error=NULL WHERE id=?").bind(String(result.order), id).run();
      order = (await orderFor(env, id))!;
    }
    if (['registered', 'connecting'].includes(order.status)) {
      if (order.project_id && order.kind === 'registration') {
        await env.DB.prepare("UPDATE domain_orders SET status='connecting' WHERE id=?").bind(id).run();
        await connect(env, order);
      }
      await env.DB.prepare("UPDATE domain_orders SET status='complete',error=NULL WHERE id=?").bind(id).run();
    }
  } catch (error) {
    const code = error instanceof DomainError ? error.message : 'registrar_unavailable';
    await env.DB.prepare('UPDATE domain_orders SET error=? WHERE id=?').bind(code, id).run();
  } finally { await env.DB.prepare('UPDATE domain_orders SET lease_until=0,last_checked_at=? WHERE id=?').bind(Date.now(),id).run(); }
  return (await orderFor(env, id))!;
}

export async function handleDomainsRequest(request: Request, env: BillingEnv): Promise<Response> {
  const cors = authCorsHeaders(request);
  if (!cors) return authJson({ error: 'origin_not_allowed' }, 403, {});
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'GET' && !request.headers.get('Origin')) return authJson({ error: 'origin_required' }, 403, cors);
  try {
    const user = await currentUser(env, request);
    if (!user) throw new DomainError('not_authenticated', 401);
    const url = new URL(request.url), path = url.pathname;
    if (path === '/domains/config' && request.method === 'GET') return authJson({ configured: billingReady(env), sandbox: env.LOCAL_DEV === 'true', tlds: DOMAIN_TLDS, canConnect: env.LOCAL_DEV !== 'true' && customDomainsConfigured(env) }, 200, cors);
    if (!registrarConfigured(env)) throw new DomainError('registrar_unavailable');
    if (path === '/domains/search' && request.method === 'POST') {
      const { keyword } = await parseBody(request, z.object({ keyword: z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9 .-]+$/) }).strict());
      const result = await namecom<{ results: SearchResult[] }>(env, '/domains:search', 'POST', { keyword, tldFilter: DOMAIN_TLDS, purchaseType: 'registration', timeout: 2500 });
      if (!Array.isArray(result.results)) throw new DomainError('registrar_unavailable');
      return authJson({ results: result.results.filter(r => domainName(r.domainName) && r.purchasable && r.purchaseType === 'registration').slice(0, 20)
        .map(r => ({ domainName: r.domainName, premium: Boolean(r.premium), amountCents: retailCents(env, usdCents(r.purchasePrice)), renewalCents: retailCents(env, usdCents(r.renewalPrice)) })) }, 200, cors);
    }
    if (path === '/domains/quote' && request.method === 'POST') return authJson({ order: publicOrder(await quote(env, user, await parseBody(request, quoteSchema))) }, 201, cors);
    if (path === '/domains/checkout' && request.method === 'POST') return authJson(await checkout(env, user, request, await parseBody(request, checkoutSchema)), 200, cors);
    if (path === '/domains/order' && request.method === 'GET') {
      const id = z.string().uuid().safeParse(url.searchParams.get('id'));
      if (!id.success) throw new DomainError('invalid_request', 400);
      const order = await orderFor(env, id.data);
      if (!order || order.user_id !== user.id) throw new DomainError('not_found', 404);
      return authJson({ order: publicOrder(await reconcileDomainOrder(env, id.data)) }, 200, cors);
    }
    if (path === '/domains' && request.method === 'GET') {
      const list = await env.DB.prepare('SELECT * FROM domain_registrations WHERE user_id=? ORDER BY domain_name').bind(user.id).all<Registration>();
      const orders = await env.DB.prepare("SELECT * FROM domain_orders WHERE user_id=? AND status NOT IN ('quoted','expired','complete','refunded') ORDER BY created_at DESC LIMIT 50").bind(user.id).all<DomainOrder>();
      return authJson({ domains: list.results.map(d => ({ domainName: d.domain_name, projectId: d.project_id, expireDate: d.expire_date,
        autoRenew: Boolean(d.auto_renew), renewalCents: d.renewal_cents, error: d.error })), orders: orders.results.map(publicOrder) }, 200, cors);
    }
    const name = domainName(url.searchParams.get('domainName'));
    if (path === '/domains/settings' && request.method === 'PATCH') {
      const value = await parseBody(request, settingsSchema), name = domainName(value.domainName);
      if (!name) throw new DomainError('invalid_request', 400);
      const owned = await ownedRegistration(env, name, user.id);
      if (value.autoRenew && !owned.payment_method_id) throw new DomainError('payment_method_required', 409);
      const patch = { ...(value.privacyEnabled !== undefined ? { privacyEnabled: value.privacyEnabled } : {}), ...(value.locked !== undefined ? { locked: value.locked } : {}) };
      if (Object.keys(patch).length) await namecom(env, nameDomainPath(name), 'PATCH', patch);
      if (value.contact) await namecom(env, `${nameDomainPath(name)}:setContacts`, 'POST', { contacts: { registrant: value.contact, admin: value.contact, billing: value.contact, tech: value.contact } });
      if (value.autoRenew !== undefined) await env.DB.prepare('UPDATE domain_registrations SET auto_renew=? WHERE domain_name=? AND user_id=?').bind(Number(value.autoRenew), name, user.id).run();
      return authJson({ saved: true }, 200, cors);
    }
    if (!name) throw new DomainError('invalid_request', 400);
    const owned = await ownedRegistration(env, name, user.id);
    if (path === '/domains/connect' && request.method === 'POST') {
      const { projectId } = await parseBody(request, z.object({ projectId: z.string().uuid().nullable() }).strict());
      if (projectId && !await env.DB.prepare('SELECT id FROM projects WHERE id=? AND user_id=?').bind(projectId, user.id).first()) throw new DomainError('not_found', 404);
      if (projectId && (env.LOCAL_DEV === 'true' || !customDomainsConfigured(env))) throw new DomainError('domain_connection_unavailable');
      const pending = await env.DB.prepare("SELECT id FROM domain_orders WHERE domain_name=? AND status IN ('checkout','charging','paid','fulfilling','registered','connecting','refunding','review')").bind(name).first();
      if (pending) throw new DomainError('domain_order_pending', 409);
      if (owned.project_id) await disconnectPurchasedDomain(env, owned.project_id, user.id, name);
      const original = await env.DB.prepare("SELECT id FROM domain_orders WHERE domain_name=? AND user_id=? AND kind='registration' AND status='complete' ORDER BY created_at DESC LIMIT 1").bind(name, user.id).first<{ id: string }>();
      if (projectId && !original) throw new DomainError('order_review_required', 409);
      await env.DB.prepare('UPDATE domain_registrations SET project_id=? WHERE domain_name=? AND user_id=?').bind(projectId, name, user.id).run();
      if (projectId && original) {
        await env.DB.prepare("UPDATE domain_orders SET project_id=?,dns_revision=?,status='connecting',error=NULL WHERE id=?").bind(projectId, crypto.randomUUID(), original.id).run();
        return authJson({ order: publicOrder(await reconcileDomainOrder(env, original.id)) }, 200, cors);
      }
      return authJson({ disconnected: true }, 200, cors);
    }
    if (path === '/domains/detail' && request.method === 'GET') {
      const domain = checkedNameDomain(await namecom<NameDomain>(env, nameDomainPath(name)), name);
      const records = await namecom<{ records: NameRecord[] }>(env, `${nameDomainPath(name)}/records`);
      await env.DB.prepare('UPDATE domain_registrations SET expire_date=? WHERE domain_name=? AND user_id=?').bind(domain.expireDate, name, user.id).run();
      const projects = await env.DB.prepare('SELECT id,name FROM projects WHERE user_id=? ORDER BY name').bind(user.id).all<{ id: string; name: string }>();
      return authJson({ domain: { ...domain, autoRenew: Boolean(owned.auto_renew), renewalCents: owned.renewal_cents }, projectId: owned.project_id, projects: projects.results, records: records.records }, 200, cors);
    }
    if (path === '/domains/verification' && request.method === 'POST') {
      const domain = await namecom<NameDomain>(env, nameDomainPath(name)), verificationId = domain.contacts?.registrant?.verificationId;
      if (!Number.isSafeInteger(verificationId)) throw new DomainError('verification_pending', 409);
      await namecom(env, `/contacts/verify/${verificationId}:resend`, 'POST', {});
      return authJson({ sent: true }, 200, cors);
    }
    if (path === '/domains/records' && request.method === 'POST') {
      const record = await parseBody(request, recordSchema);
      if (record.host.toLowerCase().startsWith('_mainbrella') || owned.project_id && ['', '@', 'www'].includes(record.host.toLowerCase())
        && ['A','AAAA','CNAME','ANAME','NS'].includes(record.type)) throw new DomainError('managed_dns_record', 409);
      return authJson({ record: await namecom(env, `${nameDomainPath(name)}/records`, 'POST', record) }, 201, cors);
    }
    if (path === '/domains/records' && request.method === 'DELETE') {
      const id = url.searchParams.get('recordId');
      if (!id || !/^\d+$/.test(id)) throw new DomainError('invalid_request', 400);
      const records = await namecom<{ records: NameRecord[] }>(env, `${nameDomainPath(name)}/records`);
      const record = records.records.find(r => String(r.id) === id);
      if (!record) throw new DomainError('not_found', 404);
      if ((record.host ?? '').toLowerCase().startsWith('_mainbrella') || owned.project_id && ['', '@', 'www'].includes((record.host ?? '').toLowerCase())
        && ['A','AAAA','CNAME','ANAME','NS'].includes(record.type)) throw new DomainError('managed_dns_record', 409);
      await namecom(env, `${nameDomainPath(name)}/records/${id}`, 'DELETE');
      return authJson({ deleted: true }, 200, cors);
    }
    if (path === '/domains/auth-code' && request.method === 'POST') {
      const domain = await namecom<NameDomain>(env, nameDomainPath(name));
      if (domain.locked) throw new DomainError('domain_locked', 409);
      return authJson(await namecom(env, `${nameDomainPath(name)}:getAuthCode`), 200, cors);
    }
    throw new DomainError('method_not_allowed', 405);
  } catch (error) {
    return authJson({ error: error instanceof DomainError ? error.message : 'registrar_unavailable' }, error instanceof DomainError ? error.status : 503, cors);
  }
}

export async function reconcileDomainOrders(env: BillingEnv) {
  if (!billingReady(env)) return;
  await env.DB.prepare("UPDATE domain_orders SET status='expired' WHERE status='quoted' AND expires_at < ?").bind(Date.now()).run();
  await env.DB.prepare("UPDATE domain_orders SET status='review',error='order_review_required' WHERE status='checkout' AND checkout_id IS NULL AND created_at < ?").bind(Date.now()-23*3600000).run();
  const orders = await env.DB.prepare("SELECT id FROM domain_orders WHERE status IN ('checkout','charging','paid','fulfilling','registered','connecting','refunding') AND lease_until < ? ORDER BY last_checked_at,created_at LIMIT 10").bind(Date.now()).all<{ id: string }>();
  for (const order of orders.results) await reconcileDomainOrder(env, order.id);
  const registrations = await env.DB.prepare(`SELECT * FROM domain_registrations r WHERE auto_renew=1 AND payment_method_id IS NOT NULL
    AND expire_date <= ? AND expire_date > ? AND error IS NULL
    AND NOT EXISTS (SELECT 1 FROM domain_orders o WHERE o.domain_name=r.domain_name AND o.status IN ('checkout','charging','paid','fulfilling','registered','connecting','refunding','review')) LIMIT 10`)
    .bind(new Date(Date.now() + 30 * 86400000).toISOString(), new Date().toISOString()).all<Registration>();
  for (const registration of registrations.results) {
    try {
      const price = await pricing(env, registration.domain_name, 1, 'renewal');
      // Customer consent covers the displayed renewal price. Increases require a
      // new checkout; never silently charge more than the agreed annual amount.
      if (price.amount > registration.renewal_cents) {
        await env.DB.prepare("UPDATE domain_registrations SET error='renewal_price_changed' WHERE domain_name=?").bind(registration.domain_name).run();
        continue;
      }
      const id = crypto.randomUUID(), now = Date.now();
      await env.DB.prepare(`INSERT INTO domain_orders (id,user_id,domain_name,kind,years,cost_cents,amount_cents,renewal_cents,premium,
        auto_renew,terms_accepted_at,customer_id,status,created_at,expires_at) VALUES (?,?,?,'renewal',1,?,?,?,?,1,?,?,'charging',?,?)`)
        .bind(id, registration.user_id, registration.domain_name, price.cost, price.amount, registration.renewal_cents, Number(price.premium), now, registration.customer_id, now, now + 86400000).run();
      await reconcileDomainOrder(env, id);
    } catch { await env.DB.prepare("UPDATE domain_registrations SET error='renewal_payment_failed' WHERE domain_name=?").bind(registration.domain_name).run(); }
  }
}

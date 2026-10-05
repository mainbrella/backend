import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import { hashToken } from './auth-core';
import { PLAN_PRICES } from '../lib/stripe';

export const USER_ONE = 'account-one';
export const USER_TWO = 'account-two';
export const SESSION_ONE = 'browser-session-one';
export const SESSION_TWO = 'browser-session-two';
export const GENERATION_ONE = '2026-10-05T12:00:00.000Z';
export const GENERATION_TWO = '2026-10-05T13:00:00.000Z';
export const EXPIRES_AT = '2099-01-01T00:00:00.000Z';
const nowSeconds = () => Math.floor(Date.now() / 1000);

export type TestContainer = { id: string; createdAt: string; expiresAt: string; status?: string };
export type BillingMode = 'paid' | 'trial' | 'past_due' | 'unpaid' | 'failure';

function migratedDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  for (const migration of [
    '../../migrations/001_initial.sql', '../../migrations/002_auth_sessions.sql',
    '../../migrations/003_pro_billing.sql', '../../migrations/004_subscription_details.sql',
    '../../migrations/009_trial_coupons.sql', '../../migrations/005_ssh_access.sql', '../../migrations/007_ssh_container_id.sql',
  ]) {
    sqlite.exec(readFileSync(fileURLToPath(new URL(migration, import.meta.url)), 'utf8'));
  }
  return sqlite;
}

export async function paidContainerFixture(t: TestContext, initialContainers: Record<string, TestContainer[]> = {}) {
  const sqlite = migratedDatabase();
  const generationFor = (userId: string) => userId === USER_ONE ? GENERATION_ONE : GENERATION_TWO;
  for (const [userId, session, generation] of [
    [USER_ONE, SESSION_ONE, GENERATION_ONE], [USER_TWO, SESSION_TWO, GENERATION_TWO],
  ]) {
    sqlite.prepare('INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)')
      .run(userId, `${userId}@example.com`, 'Test User', generation);
    sqlite.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(await hashToken(session), userId, EXPIRES_AT);
    sqlite.prepare('INSERT INTO pro_billing (user_id, stripe_customer_id, checkout_session_id) VALUES (?, ?, ?)')
      .run(userId, `cus_${userId}`, `cs_${userId}`);
  }

  const containers = new Map<string, TestContainer[]>([
    [USER_ONE, initialContainers[USER_ONE] ?? [{ id: 'small', createdAt: GENERATION_ONE, expiresAt: EXPIRES_AT }]],
    [USER_TWO, initialContainers[USER_TWO] ?? [{ id: 'small', createdAt: GENERATION_TWO, expiresAt: EXPIRES_AT }]],
  ]);
  const accountNames: string[] = [];
  const accountCalls: { name: string; request: Request }[] = [];
  const machineNames: string[] = [];
  const machineCalls: { name: string; request: Request }[] = [];
  let billingMode: BillingMode = 'paid';
  let stripePlan: keyof typeof PLAN_PRICES = 'builder';
  let subscriptionEnd: number | null = null;
  let cancelAt: number | null = null;
  let accountResponseStatus = 200;
  let terminalStatus = 101;
  let sshStatus = 101;

  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const customer = url.searchParams.get('customer') ?? USER_ONE;
    const subscriptionId = `sub_${customer}`;
    if (billingMode === 'failure') return Response.json({ error: { message: 'Stripe unavailable' } }, { status: 500 });
    if (url.pathname === '/v1/subscriptions') {
      const status = billingMode === 'trial' ? 'trialing' : billingMode === 'past_due' ? 'past_due' : 'active';
      const end = subscriptionEnd ?? nowSeconds() + 86400;
      return Response.json({
        data: [{
          id: subscriptionId, status, customer, ...(cancelAt === null ? {} : { cancel_at: cancelAt }),
          items: { data: [{ id: 'si_paid', quantity: 1,
            price: { id: PLAN_PRICES[stripePlan] }, current_period_start: nowSeconds() - 3600,
            current_period_end: end }] },
        }], has_more: false,
      });
    }
    if (url.pathname === '/v1/invoices') {
      if (billingMode === 'unpaid' || billingMode === 'trial' || billingMode === 'past_due') return Response.json({ data: [], has_more: false });
      const requestedSubscription = url.searchParams.get('subscription') ?? subscriptionId;
      return Response.json({ data: [{
        id: 'in_paid', status: 'paid', amount_paid: 500, paid_out_of_band: false,
        lines: { data: [{ id: 'il_paid', amount: 500, quantity: 1,
          pricing: { price_details: { price: PLAN_PRICES[stripePlan] } },
          parent: { subscription_item_details: { subscription: requestedSubscription, subscription_item: 'si_paid' } },
          period: { start: nowSeconds() - 3600, end: subscriptionEnd ?? nowSeconds() + 86400 },
        }], has_more: false },
      }], has_more: false });
    }
    if (url.pathname === '/v1/invoice_payments') return Response.json({ data: [{
      id: 'inpay_paid', invoice: 'in_paid', status: 'paid', amount_paid: 500,
      payment: { type: 'payment_intent', payment_intent: 'pi_paid' },
    }], has_more: false });
    if (url.pathname === '/v1/payment_intents/pi_paid') return Response.json({
      id: 'pi_paid', status: 'succeeded', amount_received: 500,
      latest_charge: { id: 'ch_paid', paid: true, amount: 500, amount_refunded: 0, refunded: false, disputed: false, status: 'succeeded' },
    });
    return Response.json({ data: [], has_more: false });
  });

  const d1 = {
    prepare(sql: string) {
      let values: unknown[] = [];
      return {
        bind(...args: unknown[]) { values = args; return this; },
        first<T>() { return (sqlite.prepare(sql).get(...values as never[]) as T | undefined) ?? null; },
        run() { const result = sqlite.prepare(sql).run(...values as never[]); return { meta: { changes: Number(result.changes) } }; },
        all<T>() { return { results: sqlite.prepare(sql).all(...values as never[]) as T[] }; },
      };
    },
  } as unknown as D1Database;

  const env = {
    DB: d1,
    STRIPE_SECRET_KEY: 'sk_test_container_fixture',
    SSH_GATEWAY_SECRET: 'gateway-secret-for-tests-12345678901234567890',
    SSH_HOSTNAME: 'ssh.mainbrella.com',
    CONTAINER_ACCOUNT: {
      idFromName(name: string) { accountNames.push(name); return name; },
      get(name: string) { return { async fetch(request: Request) {
        accountCalls.push({ name, request });
        const userId = request.headers.get('x-mainbrella-user') ?? '';
        if (accountResponseStatus !== 200) return Response.json({
          error: accountResponseStatus === 409 ? 'container_limit_exceeded' : accountResponseStatus === 429 ? 'container_quota_exceeded' : 'container service failed',
        }, { status: accountResponseStatus });
        const url = new URL(request.url);
        let list = containers.get(userId) ?? [];
        if (request.method === 'POST') {
          const id = list.length === 0 ? 'small' : `c${list.length}`;
          list = [...list, { id, createdAt: new Date().toISOString(), expiresAt: EXPIRES_AT, status: 'running' }];
          containers.set(userId, list);
        } else if (request.method === 'DELETE') {
          const id = url.searchParams.get('id') ?? list[0]?.id;
          list = list.filter(container => container.id !== id);
          containers.set(userId, list);
        }
        const id = url.searchParams.get('id');
        return Response.json({ plan: request.headers.get('x-mainbrella-plan') || null,
          active: Boolean(request.headers.get('x-mainbrella-plan')),
          limits: {}, usage: {}, containers: (id ? list.filter(container => container.id === id) : list)
            .map(container => ({ ...container, status: container.status ?? 'running' })) });
      } }; },
    },
    USER_CONTAINER: {
      idFromName(name: string) { machineNames.push(name); return name; },
      get(name: string) { return { async fetch(request: Request) {
        machineCalls.push({ name, request });
        const path = new URL(request.url).pathname;
        if (path === '/terminal') return terminalStatus === 101 ? upgradeResponse() : Response.json({ error: 'internal detail' }, { status: terminalStatus });
        if (path === '/ssh') return sshStatus === 101 ? upgradeResponse() : Response.json({ error: 'internal detail' }, { status: sshStatus });
        return Response.json({ containers: [] });
      } }; },
    },
  } as unknown as Env;

  return {
    sqlite, env, containers, accountNames, accountCalls, machineNames, machineCalls,
    generationFor,
    setBillingMode(mode: BillingMode) { billingMode = mode; },
    setStripePlan(plan: keyof typeof PLAN_PRICES) { stripePlan = plan; },
    setSubscriptionEnd(seconds: number | null) { subscriptionEnd = seconds; },
    setCancelAt(seconds: number | null) { cancelAt = seconds; },
    setAccountStatus(status: number) { accountResponseStatus = status; },
    setTerminalStatus(status: number) { terminalStatus = status; },
    setSSHStatus(status: number) { sshStatus = status; },
    close() { sqlite.close(); },
  };
}

// Node rejects status 101 in the constructor. Retain the real Response prototype
// so the router models a Worker WebSocket upgrade instead of a JSON object.
function upgradeResponse(): Response {
  return Object.defineProperties(new Response(null), {
    status: { value: 101 }, webSocket: { value: {} },
  });
}

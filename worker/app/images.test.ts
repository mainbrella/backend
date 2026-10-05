import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleRequest } from './router';
import { hashToken } from './auth-core';
import { PLAN_PRICES } from '../lib/stripe';
import { ContainerAccountController, machineName } from '../../containers/container-account-core.js';
// These dependency-free production modules are shared with the container Worker/deploy script.
// @ts-expect-error JavaScript runtime module has no declarations.
import { UserContainerController } from '../../containers/user-container-core.js';
// @ts-expect-error JavaScript deployment module has no declarations.
import { assembleImageMap } from '../../scripts/custom-images.mjs';

const secret = 's'.repeat(32);
const account = '2b7a9be82bb64187230703b024e25157';

async function fixture(t: test.TestContext, dispatch: number | 'network' = 204) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  for (const name of ['001_initial', '002_auth_sessions', '003_pro_billing', '004_subscription_details', '005_ssh_access', '006_billing_webhooks', '006_custom_images', '007_ssh_container_id', '007_image_deployment_lock']) {
    db.exec(readFileSync(new URL(`../../migrations/${name}.sql`, import.meta.url), 'utf8'));
  }
  db.prepare("INSERT INTO users (id, email) VALUES ('owner', 'owner@test.com'), ('other', 'other@test.com')").run();
  for (const user of ['owner', 'other']) {
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(await hashToken(user), user, new Date(Date.now() + 3600000).toISOString());
    db.prepare('INSERT INTO pro_billing (user_id, stripe_customer_id, checkout_session_id) VALUES (?, ?, ?)')
      .run(user, `cus_${user}`, `cs_${user}`);
  }
  class Statement {
    values: SQLInputValue[] = [];
    constructor(readonly sql: string) {}
    bind(...values: SQLInputValue[]) { this.values = values; return this; }
    async first() { return db.prepare(this.sql).get(...this.values) ?? null; }
    async all() { return { results: db.prepare(this.sql).all(...this.values) }; }
    async run() { return { meta: { changes: Number(db.prepare(this.sql).run(...this.values).changes) } }; }
  }
  const dispatches: { url: string; body: { ref: string; inputs: Record<string, string> } }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    const target = new URL(String(url));
    if (target.hostname === 'api.stripe.com') {
      const now = Math.floor(Date.now() / 1000);
      const customer = target.searchParams.get('customer') ?? 'cus_owner';
      const subscription = target.searchParams.get('subscription') ?? `sub_${customer}`;
      if (target.pathname === '/v1/subscriptions') return Response.json({ data: [{ id: subscription, status: 'active', customer,
        items: { data: [{ id: 'si_paid', quantity: 1, price: { id: PLAN_PRICES.builder }, current_period_start: now - 3600, current_period_end: now + 86400 }] },
      }], has_more: false });
      if (target.pathname === '/v1/invoices') return Response.json({ data: [{ id: 'in_paid', status: 'paid', amount_paid: 500,
        lines: { data: [{ id: 'il_paid', amount: 500, quantity: 1, pricing: { price_details: { price: PLAN_PRICES.builder } },
          parent: { subscription_item_details: { subscription, subscription_item: 'si_paid' } }, period: { start: now - 3600, end: now + 86400 } }], has_more: false },
      }], has_more: false });
      if (target.pathname === '/v1/invoice_payments') return Response.json({ data: [{ id: 'inpay_paid', invoice: 'in_paid', status: 'paid', amount_paid: 500,
        payment: { type: 'payment_intent', payment_intent: 'pi_paid' } }], has_more: false });
      if (target.pathname === '/v1/payment_intents/pi_paid') return Response.json({ id: 'pi_paid', status: 'succeeded', amount_received: 500,
        latest_charge: { id: 'ch_paid', paid: true, status: 'succeeded', amount: 500, amount_refunded: 0, refunded: false, disputed: false } });
    }
    dispatches.push({ url: String(url), body: JSON.parse(options.body as string) });
    if (dispatch === 'network') throw new Error('Network failure');
    return new Response(null, { status: dispatch });
  });
  const values = new Map();
  const starts: { image: string }[] = [];
  const container = {
    images: {} as Record<string, string>, running: false,
    start(options: { image: string }) { starts.push(options); this.running = true; },
    async setInactivityTimeout() {},
    async exec() { return { output: async () => ({ exitCode: 0 }) }; },
    async destroy() { this.running = false; },
  };
  const machineStorage = () => ({
    async get(key: string) { return structuredClone(values.get(key)); },
    async put(key: string, value: unknown) { values.set(key, structuredClone(value)); },
    async setAlarm() {}, async deleteAlarm() {},
  });
  const machines = new Map<string, UserContainerController>();
  const machineBinding = {
    idFromName(name: string) { return name; },
    get(name: string) { return { async fetch(request: Request) {
      let controller = machines.get(name);
      if (!controller) { controller = new UserContainerController({ container, storage: machineStorage() }); machines.set(name, controller); }
      return controller.fetch(request);
    } }; },
  };
  const accountControllers = new Map<string, ContainerAccountController>();
  const accountBinding = {
    idFromName(name: string) { return name; },
    get(name: string) { return { async fetch(request: Request) {
      let controller = accountControllers.get(name);
      if (!controller) {
        controller = new ContainerAccountController({ storage: machineStorage() } as never,
          (userId, id) => machineBinding.get(machineName(userId, id)) as never);
        accountControllers.set(name, controller);
      }
      return controller.fetch(request);
    } }; },
  };
  const env = {
    IMAGE_BUILD_SECRET: secret, IMAGE_BUILD_GITHUB_TOKEN: 'test-token', STRIPE_SECRET_KEY: 'sk_test_images',
    DB: { prepare(sql: string) { return new Statement(sql); }, async batch(statements: Statement[]) {
      db.exec('BEGIN');
      try { const results = []; for (const stmt of statements) results.push(await stmt.run()); db.exec('COMMIT'); return results; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    } },
    USER_CONTAINER: machineBinding,
    CONTAINER_ACCOUNT: accountBinding,
  } as unknown as Env;
  const user = (path: string, method = 'GET', body?: BodyInit, owner = 'owner') => handleRequest(new Request(`https://api.mainbrella.com${path}`, {
    method, headers: { Origin: 'https://mainbrella.com', Cookie: `mainbrella_session=${owner}` }, ...(body ? { body } : {}),
  }), env);
  const internal = (path: string, method = 'POST', body?: unknown) => handleRequest(new Request(`https://api.mainbrella.com/internal/image-builds${path}`, {
    method, headers: { Authorization: `Bearer ${secret}` }, ...(body ? { body: JSON.stringify(body) } : {}),
  }), env);
  const create = async () => {
    const form = new FormData(); form.set('name', 'My tools'); form.set('dockerfile', 'FROM mainbrella:base\nRUN echo tools\n');
    return user('/images', 'POST', form);
  };
  return { db, env, create, user, internal, container, starts, dispatches };
}

test('custom image traverses queued → building → publishing → deployed → ready → selected', async t => {
  const f = await fixture(t);
  const queued = await f.create();
  assert.equal(queued.status, 202);
  const { image } = await queued.json() as { image: { id: string; status: string } };
  const id = image.id;
  const key = `custom_${id.replaceAll('-', '')}`;
  const ref = `registry.cloudflare.com/${account}/mainbrella-custom-${id}@sha256:${'a'.repeat(64)}`;
  assert.equal(image.status, 'queued');
  assert.match(f.dispatches[0].url, /custom-image\.yml\/dispatches$/);
  assert.deepEqual(f.dispatches[0].body, { ref: 'main', inputs: { build_id: id } });
  assert.equal((await f.internal(`/${id}/status`, 'POST', { status: 'ready' })).status, 409);
  const source = await f.internal(`/${id}/source`);
  assert.equal(source.status, 200);
  assert.equal((await source.json() as { dockerfile: string }).dockerfile.replaceAll('\r\n', '\n'), 'FROM mainbrella:base\nRUN echo tools\n');
  assert.equal((await f.internal(`/${id}/source`)).status, 409);
  assert.equal((await f.internal(`/${id}/status`, 'POST', { status: 'publishing', image: ref.replace(account, 'attacker') })).status, 400);
  assert.equal((await f.internal(`/${id}/status`, 'POST', { status: 'publishing', image: ref })).status, 200);
  assert.equal((await f.user('/containers', 'POST', JSON.stringify({ imageId: id }))).status, 409);
  const manifest = await (await f.internal('/manifest', 'GET')).json();
  const images = assembleImageMap('terminal-digest', manifest, account);
  assert.deepEqual(images[key], { image: ref });
  // Simulate the platform exposing the generated Wrangler map to the real controller.
  f.container.images = Object.fromEntries(Object.entries(images).map(([key, value]) => [key, (value as { image: string }).image]));
  assert.equal((await f.internal(`/${id}/status`, 'POST', { status: 'ready' })).status, 200);
  assert.equal((await f.user('/containers', 'POST', JSON.stringify({ imageId: id }), 'other')).status, 404);
  const launch = await f.user('/containers', 'POST', JSON.stringify({ imageId: id, imageKey: 'terminal', image: 'attacker' }));
  assert.equal(launch.status, 200);
  assert.equal(f.starts[0].image, ref);
  assert.equal((await f.user(`/images/${id}`, 'DELETE')).status, 200);
  assert.deepEqual(f.dispatches.at(-1)!.body.inputs, { operation: 'reconcile' });
  const removed = assembleImageMap('terminal-digest', await (await f.internal('/manifest', 'GET')).json(), account);
  assert.equal(Object.hasOwn(removed, key), false);
  assert.equal((await f.user('/containers', 'POST', JSON.stringify({ imageId: id }))).status, 404);
});

test('definitive GitHub rejection refunds quota; ambiguous failure stays charged', async t => {
  for (const status of [400, 401, 403, 404, 422, 500, 'network'] as const) {
    await t.test(String(status), async t => {
      const f = await fixture(t, status);
      assert.equal((await f.create()).status, 503);
      assert.equal(f.db.prepare('SELECT status FROM container_images').get()!.status, 'failed');
      assert.equal(f.db.prepare('SELECT builds FROM container_image_usage').get()!.builds, status === 500 || status === 'network' ? 1 : 0);
      const id = f.db.prepare('SELECT id FROM container_images').get()!.id;
      assert.equal((await f.internal(`/${id}/source`)).status, 409);
    });
  }
});

test('deployment lease rejects competitors, ignores wrong releases, and recovers after expiry', async t => {
  const f = await fixture(t);
  const a = crypto.randomUUID(), b = crypto.randomUUID();
  assert.equal((await f.internal('/deployment-lock', 'POST', { token: a })).status, 200);
  assert.equal((await f.internal('/deployment-lock', 'POST', { token: b })).status, 409);
  await f.internal('/deployment-lock', 'DELETE', { token: b });
  assert.equal((await f.internal('/deployment-lock', 'POST', { token: b })).status, 409);
  f.db.prepare("UPDATE container_image_deployment_lock SET expires_at = '2000-01-01'").run();
  assert.equal((await f.internal('/deployment-lock', 'POST', { token: b })).status, 200);
  await f.internal('/deployment-lock', 'DELETE', { token: a });
  assert.equal((await f.internal('/deployment-lock', 'POST', { token: a })).status, 409);
  await f.internal('/deployment-lock', 'DELETE', { token: b });
  assert.equal((await f.internal('/deployment-lock', 'POST', { token: a })).status, 200);
  const unauthorized = await handleRequest(new Request('https://api.mainbrella.com/internal/image-builds/manifest'), f.env);
  assert.equal(unauthorized.status, 401);
});

test('dispatch target exists and user-controlled build has no publishing secrets', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/custom-image.yml', import.meta.url), 'utf8');
  const build = workflow.split('\n  build:\n')[1].split('\n  publish:\n')[0];
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(build, /persist-credentials: false/);
  assert.doesNotMatch(build, /secrets\.|CLOUDFLARE_API_TOKEN|IMAGE_BUILD_SECRET|GH_TOKEN/);
  assert.match(workflow, /needs: \[prepare, build\]/);
});

test('a ready image absent from the deployed map cannot start a container', async t => {
  const f = await fixture(t);
  const { image } = await (await f.create()).json() as { image: { id: string } };
  await f.internal(`/${image.id}/source`);
  await f.internal(`/${image.id}/status`, 'POST', { status: 'publishing', image: `registry.cloudflare.com/${account}/mainbrella-custom-${image.id}@sha256:${'c'.repeat(64)}` });
  await f.internal(`/${image.id}/status`, 'POST', { status: 'ready' });
  const response = await f.user('/containers', 'POST', JSON.stringify({ imageId: image.id }));
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'image_not_available' });
  assert.equal(f.starts.length, 0);
});

test('manifest reconciliation expires abandoned publishing images', async t => {
  const f = await fixture(t);
  const { image } = await (await f.create()).json() as { image: { id: string } };
  await f.internal(`/${image.id}/source`);
  await f.internal(`/${image.id}/status`, 'POST', { status: 'publishing', image: `registry.cloudflare.com/${account}/mainbrella-custom-${image.id}@sha256:${'d'.repeat(64)}` });
  f.db.prepare("UPDATE container_images SET deadline = '2000-01-01' WHERE id = ?").run(image.id);
  assert.deepEqual(await (await f.internal('/manifest', 'GET')).json(), { images: {} });
  assert.equal(f.db.prepare('SELECT status FROM container_images WHERE id = ?').get(image.id)!.status, 'failed');
  assert.equal((await f.internal(`/${image.id}/status`, 'POST', { status: 'ready' })).status, 409);
});

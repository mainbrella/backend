import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleRequest } from './router';
import { hashToken } from './auth-core';
import { PLAN_PRICES } from '../lib/stripe';
import { openImageBase, sealImageBase, parseImageBase } from '../lib/image-build-options';
import { ContainerAccountController, machineName } from '../../containers/container-account-core.js';
// These dependency-free production modules are shared with the container Worker/deploy script.
// @ts-expect-error JavaScript runtime module has no declarations.
import { UserContainerController } from '../../containers/user-container-core.js';
// @ts-expect-error JavaScript deployment module has no declarations.
import { assembleImageMap } from '../../scripts/custom-images.mjs';

const secret = 's'.repeat(32);
const account = '2b7a9be82bb64187230703b024e25157';

async function fixture(t: test.TestContext, dispatch: number | 'network' = 204, privateRepository = true) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  for (const name of ['001_initial', '002_auth_sessions', '003_pro_billing', '004_subscription_details', '005_ssh_access', '009_trial_coupons', '006_billing_webhooks', '006_custom_images', '007_ssh_container_id', '007_image_deployment_lock', '008_catalog_image_capacity', '019_prepaid_billing', '039_image_tags', '040_image_build_inputs']) {
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
    if (target.hostname === 'api.github.com' && target.pathname === '/repos/mainbrella/private-image-builder') {
      assert.equal(options.redirect, 'manual');
      return Response.json({ private: privateRepository });
    }
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
    IMAGE_BUILD_SECRET: secret, IMAGE_BUILD_GITHUB_TOKEN: 'test-token', IMAGE_BUILD_GITHUB_REPOSITORY: 'mainbrella/private-image-builder', IMAGE_REGISTRY_ENCRYPTION_KEY: 'a'.repeat(64), STRIPE_SECRET_KEY: 'sk_test_images',
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
  return { db, env, create, user, internal, container, starts, dispatches,
    setRepositoryPrivate(value: boolean) { privateRepository = value; } };
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
  assert.match(f.dispatches[0].url, /repos\/mainbrella\/private-image-builder\//);
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
  assert.match(workflow, /github\.event\.repository\.private == true/);
});

test('public or unconfigured build repositories cannot receive customer source or reserve build quota', async t => {
  const f = await fixture(t, 204, false);
  assert.equal((await f.create()).status, 503);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM container_images').get()!.n, 0);
  assert.equal(f.dispatches.length, 0);
  f.env.IMAGE_BUILD_GITHUB_REPOSITORY = undefined;
  assert.equal((await f.create()).status, 503);
  assert.equal((await (await f.user('/images')).json() as { buildsEnabled: boolean }).buildsEnabled, false);
  for (const repository of ['https://github.com/mainbrella/private-image-builder', '../private', 'owner/repo/extra', 'owner/repo?private=true']) {
    f.env.IMAGE_BUILD_GITHUB_REPOSITORY = repository;
    assert.equal((await f.create()).status, 503);
  }
});

test('repository visibility is checked again on every build and metadata errors fail closed', async t => {
  const f = await fixture(t);
  assert.equal((await f.create()).status, 202);
  f.db.prepare("UPDATE container_images SET status = 'failed'").run();
  f.setRepositoryPrivate(false);
  assert.equal((await f.create()).status, 503);
  for (const status of [301, 403, 404, 500]) {
    t.mock.method(globalThis, 'fetch', async () => new Response(null, { status }));
    assert.equal((await f.create()).status, 503);
  }
  for (const body of ['null', '{"private":true', JSON.stringify({ private: true, extra: 'x'.repeat(65 * 1024) })]) {
    t.mock.method(globalThis, 'fetch', async () => new Response(body));
    assert.equal((await f.create()).status, 503);
  }
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('metadata unavailable'); });
  assert.equal((await f.create()).status, 503);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM container_images').get()!.n, 1);
});

const privateBase = { image: `ghcr.io/customer/tools@sha256:${'b'.repeat(64)}`, username: 'pull-user', password: 'registry-password-private' };
function buildForm(options: { baseImage?: unknown; cacheFrom?: string } = {}) {
  const form = new FormData(); form.set('name', 'Private tools'); form.set('dockerfile', 'FROM mainbrella:base\nRUN echo tools\n');
  if (options.baseImage !== undefined) form.set('baseImage', JSON.stringify(options.baseImage));
  if (options.cacheFrom !== undefined) form.set('cacheFrom', options.cacheFrom);
  return form;
}

test('private base credentials are sealed at rest, never public, and consumed by exactly one source claim', async t => {
  const f = await fixture(t);
  const response = await f.user('/images', 'POST', buildForm({ baseImage: privateBase }));
  assert.equal(response.status, 202);
  const result = await response.json() as { image: { id: string; baseImage: string } };
  assert.equal(result.image.baseImage, privateBase.image);
  assert.doesNotMatch(JSON.stringify(result), /registry-password-private|pull-user/);
  const stored = f.db.prepare('SELECT * FROM container_images').get()!;
  assert.doesNotMatch(JSON.stringify(stored), /registry-password-private|pull-user/);
  assert.ok(stored.registry_credentials);
  for (const path of ['/images', `/images/${result.image.id}`, `/images/${result.image.id}/logs`]) {
    const publicResponse = await f.user(path);
    assert.doesNotMatch(await publicResponse.text(), /registry-password-private|pull-user|ciphertext/);
  }
  const claims = await Promise.all([f.internal(`/${result.image.id}/source`), f.internal(`/${result.image.id}/source`)]);
  assert.deepEqual(claims.map(response => response.status).sort(), [200, 409]);
  const source = claims.find(response => response.status === 200)!;
  assert.equal(source.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await source.json() as { baseImage: unknown }).baseImage, privateBase);
  assert.equal(f.db.prepare('SELECT registry_credentials FROM container_images').get()!.registry_credentials, null);
});

test('registry credentials are bound to both account and build, and unavailable without the separate encryption key', async t => {
  const f = await fixture(t);
  const sealed = await sealImageBase(f.env, 'owner', 'first-build', privateBase);
  assert.deepEqual(await openImageBase(f.env, 'owner', 'first-build', sealed), privateBase);
  await assert.rejects(openImageBase(f.env, 'other', 'first-build', sealed));
  await assert.rejects(openImageBase(f.env, 'owner', 'second-build', sealed));
  f.env.IMAGE_REGISTRY_ENCRYPTION_KEY = undefined;
  assert.equal((await f.user('/images', 'POST', buildForm({ baseImage: privateBase }))).status, 503);
  assert.equal((await (await f.user('/images')).json() as { privateRegistriesEnabled: boolean }).privateRegistriesEnabled, false);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM container_images').get()!.n, 0);
});

test('private image references reject tags, alternate hosts, URL credentials, invalid paths and incomplete credentials', () => {
  for (const base of [
    { ...privateBase, image: 'ghcr.io/customer/tools:latest' }, { ...privateBase, image: privateBase.image.replace('ghcr.io', 'localhost:5000') },
    { ...privateBase, image: privateBase.image.replace('ghcr.io', 'ghcr.io.evil.test') },
    { ...privateBase, image: privateBase.image.replace('customer', '../customer') },
    { ...privateBase, image: `https://${privateBase.image}` }, { ...privateBase, password: undefined },
    { ...privateBase, username: 'line\nbreak' }, { ...privateBase, password: '' }, { ...privateBase, extra: true },
  ]) assert.equal(parseImageBase(base), null);
  assert.deepEqual(parseImageBase({ image: privateBase.image }), { image: privateBase.image });
});

test('dispatch failures and expired queues erase stored registry credentials', async t => {
  await t.test('dispatch rejection', async t => {
    const f = await fixture(t, 403);
    assert.equal((await f.user('/images', 'POST', buildForm({ baseImage: privateBase }))).status, 503);
    assert.equal(f.db.prepare('SELECT registry_credentials FROM container_images').get()!.registry_credentials, null);
  });
  await t.test('expiry', async t => {
    const f = await fixture(t);
    await f.user('/images', 'POST', buildForm({ baseImage: privateBase }));
    f.db.prepare("UPDATE container_images SET deadline = '2000-01-01T00:00:00.000Z'").run();
    await f.user('/images');
    const stored = f.db.prepare('SELECT status, registry_credentials FROM container_images').get()!;
    assert.equal(stored.status, 'failed'); assert.equal(stored.registry_credentials, null);
  });
});

test('cache inputs resolve only owned ready images and pin their immutable digest', async t => {
  const f = await fixture(t);
  const { image } = await (await f.create()).json() as { image: { id: string } };
  assert.equal((await f.user('/images', 'POST', buildForm({ cacheFrom: image.id }))).status, 409);
  await f.internal(`/${image.id}/source`);
  const reference = `registry.cloudflare.com/${account}/mainbrella-custom-${image.id}@sha256:${'c'.repeat(64)}`;
  await f.internal(`/${image.id}/status`, 'POST', { status: 'publishing', image: reference });
  await f.internal(`/${image.id}/status`, 'POST', { status: 'ready' });
  assert.equal((await f.user('/images', 'POST', buildForm({ cacheFrom: image.id }), 'other')).status, 404);
  assert.equal((await f.user('/images', 'POST', buildForm({ cacheFrom: crypto.randomUUID() }))).status, 404);
  assert.equal((await f.user('/images', 'POST', buildForm({ cacheFrom: reference }))).status, 400);
  const cached = await f.user('/images', 'POST', buildForm({ cacheFrom: image.id }));
  assert.equal(cached.status, 202);
  const created = await cached.json() as { image: { id: string; cacheFrom: string } };
  assert.equal(created.image.cacheFrom, image.id);
  const source = await (await f.internal(`/${created.image.id}/source`)).json() as { cacheImage: string };
  assert.equal(source.cacheImage, reference);
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

test('catalog IDs select approved published images without reserving a custom build', async t => {
  const f = await fixture(t);
  const digest = `registry.cloudflare.com/${account}/mainbrella-python@sha256:${'e'.repeat(64)}`;
  f.container.images = { terminal: 'terminal-image', python: digest };
  const status = await (await f.user('/containers')).json() as { imageCatalog: { id: string; name: string }[] };
  assert.deepEqual(status.imageCatalog.map(image => image.id), ['node', 'python']);
  const missing = await f.user('/containers', 'POST', JSON.stringify({ catalogId: 'rust' }));
  assert.equal(missing.status, 409);
  assert.equal(f.starts.length, 0);
  const unknown = await f.user('/containers', 'POST', JSON.stringify({ catalogId: 'registry.cloudflare.com/attacker/image' }));
  assert.equal(unknown.status, 404);
  assert.equal((await f.user('/containers', 'POST', JSON.stringify({ catalogId: 'python', imageId: crypto.randomUUID() }))).status, 400);
  const launched = await f.user('/containers', 'POST', JSON.stringify({ catalogId: 'python', imageKey: 'terminal', image: 'attacker' }));
  assert.equal(launched.status, 200);
  const result = await launched.json() as { containers: { catalogId: string; imageName: string }[]; usage: { starts: number } };
  assert.equal(result.containers[0].catalogId, 'python');
  assert.equal(result.containers[0].imageName, 'Python 3.14');
  assert.equal(result.usage.starts, 1);
  assert.equal(f.starts[0].image, digest);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM container_images').get()!.count, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM container_image_usage').get()!.count, 0);
});

test('owned image tags resolve immutable digests, move between versions, and clean up on deletion', async t => {
  const f = await fixture(t);
  const first = (await (await f.create()).json() as { image: { id: string } }).image.id;
  assert.equal((await f.user('/images/tags/stable', 'PUT', JSON.stringify({ imageId: first }))).status, 409);
  const ready = async (id: string, digest: string) => {
    await f.internal(`/${id}/source`);
    await f.internal(`/${id}/status`, 'POST', { status: 'publishing', image: `registry.cloudflare.com/${account}/mainbrella-custom-${id}@sha256:${digest.repeat(64)}` });
    await f.internal(`/${id}/status`, 'POST', { status: 'ready' });
  };
  await ready(first, 'a');
  assert.equal((await f.user('/images/tags/stable', 'PUT', JSON.stringify({ imageId: first }), 'other')).status, 404);
  assert.equal((await f.user('/images/tags/stable', 'PUT', JSON.stringify({ imageId: first }))).status, 200);
  const resolved = await (await f.user('/images/tags/stable')).json() as { image: { id: string; digest: string } };
  assert.equal(resolved.image.id, first);
  assert.equal(resolved.image.digest, `sha256:${'a'.repeat(64)}`);
  assert.equal((await f.user('/images/tags/stable', 'GET', undefined, 'other')).status, 404);
  assert.deepEqual(await (await f.user('/images/tags', 'GET', undefined, 'other')).json(), { tags: [] });
  const second = (await (await f.create()).json() as { image: { id: string } }).image.id;
  await ready(second, 'b');
  assert.equal((await f.user('/images/tags/stable', 'PUT', JSON.stringify({ imageId: second }))).status, 200);
  assert.equal((await (await f.user('/images/tags/stable')).json() as { image: { id: string } }).image.id, second);
  assert.equal((await (await f.user(`/images/${first}`)).json() as { image: { digest: string } }).image.digest, `sha256:${'a'.repeat(64)}`);
  await f.user(`/images/${second}`, 'DELETE');
  assert.equal((await f.user('/images/tags/stable')).status, 404);
  assert.deepEqual(await (await f.user('/images/tags')).json(), { tags: [] });
});

test('tag writes enforce bounded admission atomically and isolate deletes by owner', async t => {
  const f = await fixture(t);
  const id = (await (await f.create()).json() as { image: { id: string } }).image.id;
  f.db.prepare("UPDATE container_images SET status = 'ready' WHERE id = ?").run(id);
  for (let i = 0; i < 30; i++) assert.equal((await f.user(`/images/tags/v${i}`, 'PUT', JSON.stringify({ imageId: id }))).status, 200);
  assert.equal((await f.user('/images/tags/overflow', 'PUT', JSON.stringify({ imageId: id }))).status, 429);
  assert.equal((await f.user('/images/tags/v0', 'PUT', JSON.stringify({ imageId: id }))).status, 200);
  assert.equal((await f.user('/images/tags/v0', 'DELETE', undefined, 'other')).status, 200);
  assert.equal((await f.user('/images/tags/v0')).status, 200);
  assert.equal((await f.user('/images/tags/v0', 'DELETE')).status, 200);
  assert.equal((await f.user('/images/tags/overflow', 'PUT', JSON.stringify({ imageId: id }))).status, 200);
  assert.equal((await f.user('/images/tags/v1', 'PUT', JSON.stringify({ imageId: id, extra: true }))).status, 400);
  assert.equal((await f.user('/images/tags/Bad', 'PUT', JSON.stringify({ imageId: id }))).status, 404);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { ContainerAccountController, machineName } from '../../containers/container-account-core.js';
// The lifecycle controller is intentionally JavaScript and has no TypeScript declaration.
// @ts-expect-error Integration test exercises the shipped JavaScript controller directly.
import { UserContainerController } from '../../containers/user-container-core.js';
import { handleRequest } from './router';
import { paidContainerFixture, SESSION_ONE, USER_ONE } from './paid-container-test-helpers';

function storage() {
  const values = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    async get<T>(key: string) { return structuredClone(values.get(key)) as T | undefined; },
    async put(key: string, value: unknown) { values.set(key, structuredClone(value)); },
    async delete(key: string) { return values.delete(key); },
    async setAlarm(at: number) { alarm = at; },
    async deleteAlarm() { alarm = null; },
    alarmValue() { return alarm; },
  };
}

function realControllers(env: Env, now: () => number, customImages: Record<string, { image: string }> = {}) {
  const accountControllers = new Map<string, ContainerAccountController>();
  const machines = new Map<string, { controller: UserContainerController; runtime: FakeRuntime }>();
  const accountRequests: { name: string; request: Request }[] = [];
  const machineRequests: { name: string; request: Request }[] = [];

  function machine(name: string) {
    let found = machines.get(name);
    if (!found) {
      const runtime = new FakeRuntime(customImages);
      const ctx = { container: runtime, storage: storage() } as never;
      found = { controller: new UserContainerController(ctx, now), runtime };
      machines.set(name, found);
    }
    return found;
  }
  const machineBinding = {
    idFromName(name: string) { return name; },
    get(name: string) { return { async fetch(request: Request) {
      machineRequests.push({ name, request: request.clone() as unknown as Request });
      return machine(name).controller.fetch(request);
    } }; },
  };
  const accountBinding = {
    idFromName(name: string) { return name; },
    get(name: string) { return { async fetch(request: Request) {
      accountRequests.push({ name, request: request.clone() as unknown as Request });
      let controller = accountControllers.get(name);
      if (!controller) {
        const ctx = { storage: storage() } as never;
        controller = new ContainerAccountController(ctx, (userId, id) => machineBinding.get(machineName(userId, id)) as never, now);
        accountControllers.set(name, controller);
      }
      return controller.fetch(request);
    } }; },
  };
  return { env: { ...env, USER_CONTAINER: machineBinding, CONTAINER_ACCOUNT: accountBinding } as unknown as Env,
    accountRequests, machineRequests, machines };
}

class FakeRuntime {
  running = false;
  images: Record<string, { image: string }>;
  startCalls = 0;
  startOptions: unknown[] = [];
  destroyCalls = 0;
  inactivityTimeouts: number[] = [];
  constructor(customImages: Record<string, { image: string }> = {}) {
    this.images = { terminal: { image: 'terminal-test-image' }, ...customImages };
  }
  start(options: unknown) { this.startCalls++; this.startOptions.push(options); this.running = true; }
  async destroy() { this.destroyCalls++; this.running = false; }
  async setInactivityTimeout(timeout: number) { this.inactivityTimeouts.push(timeout); }
  async exec() { return { output: async () => ({ exitCode: 0, stdout: 'ready' }) }; }
}

test('paid container entitlements flow through the real account and machine controllers', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const f = await paidContainerFixture(t);
  t.after(() => f.close());
  const system = realControllers(f.env, () => now);
  const request = (method: 'GET' | 'POST', path = '/containers') => new Request(`https://api.mainbrella.com${path}`, {
    method, headers: { Origin: 'https://mainbrella.com', Cookie: `mainbrella_session=${SESSION_ONE}` },
  });

  f.setBillingMode('unpaid');
  f.sqlite.prepare('DELETE FROM pro_billing WHERE user_id = ?').run(USER_ONE);
  const unpaid = await handleRequest(request('POST'), system.env);
  assert.equal(unpaid.status, 402);
  assert.deepEqual(await unpaid.json(), { error: 'subscription_required' });
  assert.equal(system.accountRequests.length, 0);
  assert.equal(system.machines.size, 0);
  f.sqlite.prepare('INSERT INTO pro_billing (user_id, stripe_customer_id, checkout_session_id) VALUES (?, ?, ?)')
    .run(USER_ONE, `cus_${USER_ONE}`, `cs_${USER_ONE}`);

  const baseSeconds = Math.floor(now / 1000);
  const paidUntil = baseSeconds + 20 * 60;
  f.setSubscriptionEnd(paidUntil);
  f.setStripePlan('builder');
  f.setBillingMode('paid');
  for (let start = 0; start < 5; start++) {
    const response = await handleRequest(request('POST'), system.env);
    assert.equal(response.status, 200);
    const state = await response.json() as { plan: string; active: boolean; limits: { maxContainers: number }; usage: { starts: number }; containers: unknown[] };
    assert.equal(state.plan, 'builder');
    assert.equal(state.active, true);
    assert.equal(state.limits.maxContainers, 5);
    assert.equal(state.usage.starts, start + 1);
    assert.equal(state.containers.length, start + 1);
    now += 60_000;
  }
  const builderCap = await handleRequest(request('POST'), system.env);
  assert.equal(builderCap.status, 409);
  assert.deepEqual(await builderCap.json(), { error: 'container_limit_exceeded' });
  assert.equal(system.machines.size, 5);
  assert.equal([...system.machines.values()].reduce((sum, item) => sum + item.runtime.startCalls, 0), 5);

  f.setStripePlan('pro');
  const upgraded = await handleRequest(request('POST'), system.env);
  assert.equal(upgraded.status, 200);
  const proState = await upgraded.json() as { plan: string; active: boolean; limits: { maxContainers: number }; usage: { starts: number }; containers: { id: string }[] };
  assert.equal(proState.plan, 'pro');
  assert.equal(proState.active, true);
  assert.equal(proState.limits.maxContainers, 100);
  assert.equal(proState.containers.length, 6);
  assert.equal(proState.usage.starts, 6);
  assert.deepEqual(proState.containers.map(container => container.id), ['small', 'c1', 'c2', 'c3', 'c4', 'c5']);
  assert.equal([...system.machines.values()].reduce((sum, item) => sum + item.runtime.startCalls, 0), 6);
  const paidRequests = system.accountRequests.filter(({ request: forwarded }) => forwarded.method === 'POST');
  assert.ok(paidRequests.some(({ request: forwarded }) => forwarded.headers.get('x-mainbrella-plan') === 'builder'));
  assert.ok(paidRequests.some(({ request: forwarded }) => forwarded.headers.get('x-mainbrella-plan') === 'pro'));
  assert.ok(paidRequests.every(({ request: forwarded }) => Number(forwarded.headers.get('x-mainbrella-paid-until')) === paidUntil * 1000));

  // A canceled subscription keeps its paid-through period; switching the next
  // period back to Builder clamps the live slots without resetting monthly use.
  f.setStripePlan('builder');
  f.setCancelAt(paidUntil);
  const downgradedResponse = await handleRequest(request('GET'), system.env);
  assert.equal(downgradedResponse.status, 200);
  const downgraded = await downgradedResponse.json() as { plan: string; active: boolean; limits: { maxContainers: number }; usage: { starts: number }; containers: { id: string }[] };
  assert.equal(downgraded.plan, 'builder');
  assert.equal(downgraded.active, true);
  assert.equal(downgraded.limits.maxContainers, 5);
  assert.deepEqual(downgraded.containers.map(container => container.id), ['small', 'c1', 'c2', 'c3', 'c4']);
  assert.equal(downgraded.usage.starts, 6);
  assert.equal(system.machines.get('user:account-one:slot:5')!.runtime.running, false);
  assert.equal(system.machines.get('user:account-one:slot:5')!.runtime.destroyCalls, 1);

  now = paidUntil * 1000 + 1;
  const expiredResponse = await handleRequest(request('GET'), system.env);
  assert.equal(expiredResponse.status, 200);
  const expired = await expiredResponse.json() as { plan: string | null; active: boolean; limits: { maxContainers: number }; usage: { starts: number }; containers: unknown[] };
  assert.equal(expired.plan, null);
  assert.equal(expired.active, false);
  assert.equal(expired.limits.maxContainers, 0);
  assert.equal(expired.containers.length, 0);
  assert.equal(expired.usage.starts, 6);
  assert.ok([...system.machines.values()].every(({ runtime }) => !runtime.running));
  for (const name of ['user:account-one', ...[1, 2, 3, 4].map(slot => `user:account-one:slot:${slot}`)]) {
    assert.ok(system.machineRequests.some(({ name: target, request: forwarded }) => target === name
      && forwarded.method === 'DELETE' && forwarded.headers.get('x-mainbrella-plan') === ''
      && Number(forwarded.headers.get('x-mainbrella-reservation')) > 0));
  }
  assert.ok([...system.machines.values()].every(({ runtime }) => runtime.destroyCalls === 1));
  assert.equal(system.accountRequests.at(-1)!.request.headers.get('x-mainbrella-plan'), '');
  assert.equal(system.accountRequests.at(-1)!.request.headers.get('x-mainbrella-paid-until'), '0');
});

test('an unpaid create request revokes existing machines without launching or charging another start', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  const system = realControllers(f.env, () => Date.now());
  const request = (method = 'GET') => new Request('https://api.mainbrella.com/containers', { method,
    headers: { Origin: 'https://mainbrella.com', Cookie: `mainbrella_session=${SESSION_ONE}` } });
  assert.equal((await handleRequest(request('POST'), system.env)).status, 200);
  const existing = system.machines.get(`user:${USER_ONE}`)!;
  assert.equal(existing.runtime.running, true);
  f.setBillingMode('unpaid');
  const denied = await handleRequest(request('POST'), system.env);
  assert.equal(denied.status, 402); assert.equal(existing.runtime.running, false);
  assert.equal(existing.runtime.startCalls, 1);
  assert.equal(system.accountRequests.at(-1)!.request.method, 'PUT');
  const state = await (await handleRequest(request(), system.env)).json() as { usage: { starts: number }; containers: unknown[] };
  assert.equal(state.usage.starts, 1); assert.equal(state.containers.length, 0);
});

test('paid custom-image launches resolve ownership before forwarding selection through both controllers', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  f.sqlite.exec((await import('node:fs')).readFileSync(new URL('../../migrations/006_custom_images.sql', import.meta.url), 'utf8'));
  const readyId = '10000000-0000-4000-8000-000000000001';
  const foreignId = '10000000-0000-4000-8000-000000000002';
  const buildingId = '10000000-0000-4000-8000-000000000003';
  const unmappedId = '10000000-0000-4000-8000-000000000004';
  const image = (id: string, owner: string, status: string, imageKey: string, name: string) => {
    f.sqlite.prepare(`INSERT INTO container_images
      (id, user_id, name, status, dockerfile, image_key, created_at, updated_at, deadline, month)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, owner, name, status, 'FROM mainbrella:base', imageKey,
        '2026-10-05T12:00:00.000Z', '2026-10-05T12:00:00.000Z', '2099-01-01T00:00:00.000Z', '2026-10');
  };
  image(readyId, USER_ONE, 'ready', `custom_${readyId.replaceAll('-', '')}`, 'My tools');
  image(foreignId, 'account-two', 'ready', `custom_${foreignId.replaceAll('-', '')}`, 'Other user image');
  image(buildingId, USER_ONE, 'failed', `custom_${buildingId.replaceAll('-', '')}`, 'Still building');
  image(unmappedId, USER_ONE, 'ready', `custom_${unmappedId.replaceAll('-', '')}`, 'Not deployed');
  const system = realControllers(f.env, () => Date.now(), {
    [`custom_${readyId.replaceAll('-', '')}`]: { image: 'registry.example/my-tools@sha256:abc' },
  });
  const request = (body?: string) => new Request('https://api.mainbrella.com/containers', {
    method: 'POST', headers: { Origin: 'https://mainbrella.com', Cookie: `mainbrella_session=${SESSION_ONE}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body }),
  });

  f.setBillingMode('unpaid');
  f.sqlite.prepare('DELETE FROM pro_billing WHERE user_id = ?').run(USER_ONE);
  const unpaid = await handleRequest(request(JSON.stringify({ imageId: readyId })), system.env);
  assert.equal(unpaid.status, 402);
  assert.deepEqual(await unpaid.json(), { error: 'subscription_required' });
  assert.equal(system.accountRequests.length, 0);
  assert.equal(system.machines.size, 0);
  f.sqlite.prepare('INSERT INTO pro_billing (user_id, stripe_customer_id, checkout_session_id) VALUES (?, ?, ?)')
    .run(USER_ONE, `cus_${USER_ONE}`, `cs_${USER_ONE}`);
  f.setBillingMode('paid');
  f.sqlite.prepare("UPDATE container_images SET status = 'building' WHERE id = ?").run(buildingId);

  for (const [body, status, expected] of [
    ['{', 400, 'invalid_request'],
    [JSON.stringify({ imageId: 7 }), 400, 'invalid_request'],
    [JSON.stringify({ imageId: '10000000-0000-4000-8000-000000000099' }), 404, 'image_not_found'],
    [JSON.stringify({ imageId: foreignId }), 404, 'image_not_found'],
    [JSON.stringify({ imageId: buildingId }), 409, 'image_not_ready'],
  ] as const) {
    const response = await handleRequest(request(body), system.env);
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: expected });
  }
  assert.equal(system.accountRequests.length, 0);
  assert.equal(system.machines.size, 0);

  const selected = await handleRequest(request(JSON.stringify({ imageId: readyId, imageKey: 'terminal', image: 'attacker' })), system.env);
  assert.equal(selected.status, 200);
  const state = await selected.json() as { containers: { imageId?: string; imageName?: string }[] };
  assert.equal(state.containers[0].imageId, readyId);
  assert.equal(state.containers[0].imageName, 'My tools');
  const customAccountRequest = system.accountRequests.find(({ request: forwarded }) => forwarded.method === 'POST')!.request;
  assert.deepEqual(await customAccountRequest.json(), {
    imageKey: `custom_${readyId.replaceAll('-', '')}`, imageId: readyId, imageName: 'My tools',
  });
  assert.equal(customAccountRequest.headers.get('x-mainbrella-plan'), 'builder');
  const customMachineRequest = system.machineRequests.find(({ request: forwarded }) => forwarded.method === 'POST')!.request;
  assert.deepEqual(await customMachineRequest.json(), {
    imageKey: `custom_${readyId.replaceAll('-', '')}`, imageId: readyId, imageName: 'My tools',
  });
  assert.ok(Number(customMachineRequest.headers.get('x-mainbrella-reservation')) > 0);
  const customRuntime = system.machines.get('user:account-one')!.runtime;
  assert.equal(customRuntime.startOptions[0] && (customRuntime.startOptions[0] as { image: { image: string } }).image.image,
    'registry.example/my-tools@sha256:abc');

  const defaultStart = await handleRequest(request(), system.env);
  assert.equal(defaultStart.status, 200);
  const defaultAccountRequest = system.accountRequests.filter(({ request: forwarded }) => forwarded.method === 'POST').at(-1)!.request;
  assert.equal(defaultAccountRequest.headers.get('content-type'), null);
  assert.equal(defaultAccountRequest.body, null);
  const defaultMachineRequest = system.machineRequests.filter(({ request: forwarded }) => forwarded.method === 'POST').at(-1)!.request;
  assert.equal(defaultMachineRequest.headers.get('content-type'), null);
  assert.equal(defaultMachineRequest.body, null);
  assert.equal((system.machines.get('user:account-one:slot:1')!.runtime.startOptions[0] as { image: { image: string } }).image.image,
    'terminal-test-image');

  const unavailable = await handleRequest(request(JSON.stringify({ imageId: unmappedId })), system.env);
  assert.equal(unavailable.status, 409);
  assert.deepEqual(await unavailable.json(), { error: 'image_not_available' });
  const unavailableMachine = system.machines.get('user:account-one:slot:2')!;
  assert.equal(unavailableMachine.runtime.startCalls, 0);
});

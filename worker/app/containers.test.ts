import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from './router';
import { paidContainerFixture, SESSION_ONE, USER_ONE } from './paid-container-test-helpers';

function request(method = 'GET', origin: string | null = 'https://mainbrella.com', cookie = true, path = '/containers') {
  return new Request(`https://api.mainbrella.com${path}`, {
    method,
    headers: { ...(origin ? { Origin: origin } : {}), ...(cookie ? { Cookie: `mainbrella_session=${SESSION_ONE}` } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify({ userId: 'victim', instance: 'standard-2', keepAliveMs: 99999999 }) } : {}),
  });
}

test('internet-off is gated, strictly typed and forwarded only as a trusted boolean', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  const call = (internet: unknown) => handleRequest(new Request('https://api.mainbrella.com/containers', { method: 'POST',
    headers: { Origin: 'https://mainbrella.com', Cookie: `mainbrella_session=${SESSION_ONE}` }, body: JSON.stringify({ internet, imageKey: 'attacker', enableInternet: true }) }), f.env);
  for (const internet of ['false', null, 0, {}]) assert.equal((await call(internet)).status, 400);
  const disabled = await call(false); assert.equal(disabled.status, 503); assert.deepEqual(await disabled.json(), { error: 'network_policy_unavailable' });
  assert.equal(f.accountCalls.length, 0); f.env.NETWORK_INTERNET_CONTROL_ENABLED = 'true';
  assert.equal((await call(false)).status, 200); assert.deepEqual(await f.accountCalls.at(-1)!.request.json(), { internet: false });
  assert.equal((await call(true)).status, 200); assert.deepEqual(await f.accountCalls.at(-1)!.request.json(), { internet: true });
});

test('container routes require a session and trusted origins for mutations', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  assert.equal((await handleRequest(request('OPTIONS', undefined, false), f.env)).status, 204);
  for (const method of ['GET', 'POST', 'DELETE']) {
    assert.equal((await handleRequest(request(method, undefined, false), f.env)).status, 401);
    assert.equal((await handleRequest(request(method, 'https://attacker.com'), f.env)).status, 403);
  }
  for (const method of ['POST', 'DELETE']) assert.equal((await handleRequest(request(method, null), f.env)).status, 403);
  assert.equal(f.accountCalls.length, 0);
});

test('paid reads and starts use the private coordinator and pass only the trusted owner and entitlement', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  for (const method of ['GET', 'POST']) {
    const response = await handleRequest(request(method), f.env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://mainbrella.com');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(f.accountNames.at(-1), 'account:account-one');
    const forwarded = f.accountCalls.at(-1)!.request;
    assert.equal(forwarded.method, method);
    assert.equal(forwarded.url, 'https://internal/containers');
    assert.equal(forwarded.headers.get('x-mainbrella-user'), USER_ONE);
    assert.equal(forwarded.headers.get('x-mainbrella-plan'), 'builder');
    assert.ok(Number(forwarded.headers.get('x-mainbrella-paid-until')) > Date.now());
    assert.deepEqual([...forwarded.headers.keys()].sort(), ['x-mainbrella-checked-at', 'x-mainbrella-paid-until', 'x-mainbrella-plan', 'x-mainbrella-user']);
    assert.equal(await forwarded.text(), '');
  }
  const deleted = await handleRequest(request('DELETE'), f.env);
  assert.equal(deleted.status, 200);
  assert.equal(f.accountCalls.at(-1)!.request.headers.get('x-mainbrella-cleanup'), '1');
  assert.equal(f.accountCalls.at(-1)!.request.headers.get('x-mainbrella-plan'), '');
  await handleRequest(request('GET', 'https://mainbrella.com', true, '/containers?id=small'), f.env);
  assert.equal(f.accountCalls.at(-1)!.request.url, 'https://internal/containers?id=small');
});

test('unpaid starts spend no quota and propagate revocation for existing billing customers', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  for (const mode of ['unpaid', 'trial', 'past_due'] as const) {
    f.setBillingMode(mode);
    const before = f.accountCalls.length;
    const response = await handleRequest(request('POST'), f.env);
    assert.equal(response.status, 402, mode);
    assert.deepEqual(await response.json(), { error: 'subscription_required' });
    assert.equal(f.accountCalls.length, before + 1);
    assert.equal(f.accountCalls.at(-1)!.request.method, 'PUT');
    assert.equal(f.accountCalls.at(-1)!.request.headers.get('x-mainbrella-plan'), '');
    assert.equal(f.machineCalls.length, 0);
  }
  f.setBillingMode('failure');
  const beforeFailure = f.accountCalls.length;
  const response = await handleRequest(request('POST'), f.env);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'billing_unavailable' });
  assert.equal(f.accountCalls.length, beforeFailure);
});

test('a never-billed user gets 402 without touching any coordinator or machine', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  f.sqlite.prepare('DELETE FROM pro_billing WHERE user_id = ?').run(USER_ONE);
  assert.equal((await handleRequest(request('POST'), f.env)).status, 402);
  assert.equal(f.accountCalls.length, 0); assert.equal(f.machineCalls.length, 0);
});

test('unpaid revocation failure never hides the 402 billing requirement', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  t.mock.method(console, 'error', () => {});
  f.setBillingMode('unpaid'); f.setAccountStatus(503);
  const response = await handleRequest(request('POST'), f.env);
  assert.equal(response.status, 402);
  assert.deepEqual(await response.json(), { error: 'subscription_required' });
  assert.equal(f.accountCalls[0].request.method, 'PUT');
});

test('native request context defers cleanup so unpaid creation returns 402 promptly', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close()); f.setBillingMode('unpaid');
  const background: Promise<unknown>[] = [];
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const env = { ...f.env, CONTAINER_ACCOUNT: {
    idFromName(name: string) { return f.env.CONTAINER_ACCOUNT!.idFromName(name); },
    get(id: DurableObjectId) {
      const stub = f.env.CONTAINER_ACCOUNT!.get(id);
      return { async fetch(req: Request) { await gate; return stub.fetch(req); } };
    },
  } } as unknown as Env;
  const ctx = { waitUntil(promise: Promise<unknown>) { background.push(promise); } } as ExecutionContext;
  const response = await handleRequest(request('POST'), env, ctx);
  assert.equal(response.status, 402); assert.equal(background.length, 1);
  assert.equal(f.accountCalls.length, 0);
  release(); await Promise.all(background);
  assert.equal(f.accountCalls[0].request.method, 'PUT');
});

test('stop remains available during a Stripe outage and carries cleanup-only authority', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  f.setBillingMode('failure');
  const response = await handleRequest(request('DELETE', 'https://mainbrella.com', true, '/containers?id=small&createdAt=2026-10-05T12%3A00%3A00.000Z'), f.env);
  assert.equal(response.status, 200);
  assert.equal(f.accountCalls.length, 1);
  const forwarded = f.accountCalls[0].request;
  assert.equal(forwarded.url, 'https://internal/containers?id=small&createdAt=2026-10-05T12%3A00%3A00.000Z');
  assert.equal(forwarded.headers.get('x-mainbrella-cleanup'), '1');
  assert.equal(forwarded.headers.get('x-mainbrella-user'), USER_ONE);
  assert.equal(forwarded.headers.get('x-mainbrella-plan'), '');
  assert.equal(forwarded.headers.get('x-mainbrella-paid-until'), '0');
});

test('unpaid reads report no entitlement while malformed IDs and unsupported methods are rejected', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  f.setBillingMode('unpaid');
  const response = await handleRequest(request('GET'), f.env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { plan: null, active: false, limits: {}, usage: {}, containers: [
    { id: 'small', createdAt: '2026-10-05T12:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', status: 'running' },
  ] });
  const headers = f.accountCalls.at(-1)!.request.headers;
  assert.equal(headers.get('x-mainbrella-plan'), '');
  assert.equal(headers.get('x-mainbrella-paid-until'), '0');
  assert.equal((await handleRequest(request('GET', undefined, true, '/containers/victim'), f.env)).status, 404);
  assert.equal((await handleRequest(request('GET', 'https://mainbrella.com', true, '/containers?id=victim'), f.env)).status, 400);
  assert.equal((await handleRequest(request('GET', 'https://mainbrella.com', true, '/containers?id=small&id=c1'), f.env)).status, 400);
  assert.equal((await handleRequest(request('PATCH'), f.env)).status, 405);
});

test('account and machine failures are sanitized while coordinator quota errors are preserved', async t => {
  t.mock.method(console, 'error', () => {});
  const f = await paidContainerFixture(t); t.after(() => f.close());
  f.setAccountStatus(409);
  let response = await handleRequest(request('POST'), f.env);
  assert.equal(response.status, 409);
  f.setAccountStatus(429);
  response = await handleRequest(request('POST'), f.env);
  assert.equal(response.status, 429);
  f.setAccountStatus(500);
  response = await handleRequest(request('GET'), f.env);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'containers_unavailable' });
  response = await handleRequest(request('GET'), { ...f.env, CONTAINER_ACCOUNT: undefined } as unknown as Env);
  assert.equal(response.status, 503);
});

test('automation accepts Bearer sessions without Origin and never forwards credentials', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  const bearer = 'a'.repeat(64);
  f.sqlite.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(await import('./auth-core').then(({ hashToken }) => hashToken(bearer)), USER_ONE, '2099-01-01T00:00:00.000Z');
  for (const method of ['GET', 'POST', 'DELETE']) {
    const req = new Request('https://api.mainbrella.com/containers', { method, headers: { Authorization: `Bearer ${bearer}` } });
    assert.equal((await handleRequest(req, f.env)).status, 200);
    assert.equal(f.accountNames.at(-1), 'account:account-one');
    assert.equal(f.accountCalls.at(-1)!.request.headers.get('Authorization'), null);
  }
  for (const authorization of ['', 'Basic abc', 'Bearer invalid']) {
    const req = new Request('https://api.mainbrella.com/containers', {
      method: 'POST', headers: { Authorization: authorization, Cookie: `mainbrella_session=${SESSION_ONE}` },
    });
    assert.equal((await handleRequest(req, f.env)).status, 401);
  }
  assert.equal(f.accountCalls.length, 3);
  const untrusted = new Request('https://api.mainbrella.com/containers', {
    method: 'POST', headers: { Authorization: `Bearer ${bearer}`, Origin: 'https://attacker.com' },
  });
  assert.equal((await handleRequest(untrusted, f.env)).status, 403);
});


test('creation validates and forwards only POST idempotency keys, with browser CORS support', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  const keyed = (method: string, key: string) => new Request('https://api.mainbrella.com/containers', {
    method, headers: { Origin: 'https://mainbrella.com', Cookie: `mainbrella_session=${SESSION_ONE}`, 'Idempotency-Key': key },
  });
  for (const key of ['', 'invalid key', 'a'.repeat(129), 'one,two']) {
    assert.equal((await handleRequest(keyed('POST', key), f.env)).status, 400);
  }
  assert.equal(f.accountCalls.length, 0);
  assert.equal((await handleRequest(keyed('POST', 'safe-retry_1'), f.env)).status, 200);
  assert.equal(f.accountCalls.at(-1)!.request.headers.get('Idempotency-Key'), 'safe-retry_1');
  await handleRequest(keyed('GET', 'ignored'), f.env);
  assert.equal(f.accountCalls.at(-1)!.request.headers.get('Idempotency-Key'), null);
  const preflight = await handleRequest(keyed('OPTIONS', 'safe-retry_1'), f.env);
  assert.match(preflight.headers.get('access-control-allow-headers')!, /idempotency-key/);
});

test('named sizes are validated and forwarded without trusting raw resource or budget fields', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  const call = (body: unknown) => handleRequest(new Request('https://api.mainbrella.com/containers', {
    method: 'POST', headers: { Origin: 'https://mainbrella.com', Cookie: `mainbrella_session=${SESSION_ONE}` }, body: JSON.stringify(body),
  }), f.env);
  for (const size of ['lite', 'small', 'medium', 'large', 'xl']) {
    assert.equal((await call({ size, instance: 'arbitrary', computeExpiresAt: Date.now() + 9999999999 })).status, 200);
    assert.deepEqual(await f.accountCalls.at(-1)!.request.json(), { size });
  }
  const calls = f.accountCalls.length;
  for (const size of ['basic', 'standard-1', 'XL', '', null, 1, { vcpu: 4 }]) {
    const response = await call({ size });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_size' });
  }
  assert.equal(f.accountCalls.length, calls);
});


test('container names are validated and trimmed before forwarding to the account', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  const call = (name: unknown) => handleRequest(new Request('https://api.mainbrella.com/containers', {
    method: 'POST', headers: { Origin: 'https://mainbrella.com', Cookie: `mainbrella_session=${SESSION_ONE}` },
    body: JSON.stringify({ name, catalogId: 'node' }),
  }), f.env);
  for (const name of ['', '   ', 'a'.repeat(81), null, 123, 'bad\nname']) {
    const response = await call(name);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_container_name' });
  }
  assert.equal(f.accountCalls.length, 0);
  assert.equal((await call('  My API  ')).status, 200);
  const body = await f.accountCalls.at(-1)!.request.json() as { name: string; imageName: string };
  assert.equal(body.name, 'My API');
  assert.ok(body.imageName);
});

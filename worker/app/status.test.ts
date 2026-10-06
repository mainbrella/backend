import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleRequest } from './router';
import { collectStatus, recordObservations, STATUS_COMPONENTS, STATUS_STALE_MS } from './status';

function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../../migrations/011_operational_status.sql', import.meta.url), 'utf8'));
  const db = {
    async batch(statements: { run(): unknown }[]) { return statements.map(statement => statement.run()); },
    prepare(sql: string) {
      let args: unknown[] = [];
      return { bind(...values: unknown[]) { args = values; return this; },
        first() { return sqlite.prepare(sql).get(...args as never[]) ?? null; },
        all() { return { results: sqlite.prepare(sql).all(...args as never[]) }; },
        run() { const result = sqlite.prepare(sql).run(...args as never[]); return { meta: { changes: Number(result.changes) } }; } };
    },
  } as unknown as D1Database;
  t.after(() => sqlite.close());
  return { sqlite, env: { DB: db, MONITORING_SECRET: 'test-monitoring-secret' } as Env };
}
const request = (path = '/status', body?: unknown, credential = 'test-monitoring-secret') => new Request('https://api.mainbrella.com' + path, {
  method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body),
  headers: { Authorization: `Bearer ${credential}` },
});

test('status starts unknown, distinguishes stale evidence and preserves scoped observations/history', async t => {
  const f = fixture(t);
  const empty = await (await handleRequest(request(), f.env)).json() as any;
  assert.equal(empty.state, 'unknown'); assert.equal(empty.components.length, 7);
  await recordObservations(f.env, STATUS_COMPONENTS.map(component => ({ component, state: 'operational', scope: 'synthetic' })));
  const live = await (await handleRequest(request(), f.env)).json() as any;
  assert.equal(live.state, 'operational');
  f.sqlite.prepare('UPDATE status_observations SET checked_at = ? WHERE component = ?')
    .run(new Date(Date.now() - STATUS_STALE_MS - 1000).toISOString(), 'ssh');
  const stale = await (await handleRequest(request(), f.env)).json() as any;
  assert.equal(stale.state, 'unknown'); assert.equal(stale.components.find((c: any) => c.component === 'ssh').stale, true);
  await recordObservations(f.env, [{ component: 'api', state: 'outage', scope: 'reachability' }]);
  assert.equal((await (await handleRequest(request(), f.env)).json() as any).state, 'outage');
  const history = await (await handleRequest(request('/status/history?component=api'), f.env)).json() as any;
  assert.equal(history.observations.length, 2);
  assert.ok(history.observations.every((o: any) => o.component === 'api'));
  assert.equal((await handleRequest(request('/status/history?component=unknown'), f.env)).status, 400);
});

test('observations and incidents require the dedicated credential and reject malformed/unbounded input', async t => {
  const f = fixture(t);
  const observations = { observations: [{ component: 'provisioning', state: 'operational', scope: 'synthetic', latencyMs: 42 }] };
  assert.equal((await handleRequest(request('/internal/status/observations', observations, 'mb_account_key'), f.env)).status, 401);
  assert.equal((await handleRequest(request('/internal/status/observations', observations), {} as Env)).status, 401);
  assert.equal((await handleRequest(request('/internal/status/observations', observations), f.env)).status, 200);
  assert.equal((await handleRequest(request('/internal/status/observations', { observations: [...observations.observations, ...observations.observations] }), f.env)).status, 400);
  assert.equal((await handleRequest(request('/internal/status/observations', { observations: [{ ...observations.observations[0], checkedAt: 'future' }] }), f.env)).status, 400);
  assert.equal((await handleRequest(new Request('https://api.mainbrella.com/internal/status/observations', { method: 'POST', body: '{bad',
    headers: { Authorization: 'Bearer test-monitoring-secret' } }), f.env)).status, 400);
  const incident = { id: crypto.randomUUID(), component: 'api', title: 'API disruption', state: 'investigating', message: 'Requests are failing.' };
  assert.equal((await handleRequest(request('/internal/status/incidents', incident), f.env)).status, 200);
  let status = await (await handleRequest(request(), f.env)).json() as any;
  assert.equal(status.state, 'degraded'); assert.equal(status.incidents.length, 1);
  assert.equal((await handleRequest(request('/internal/status/incidents', { ...incident, state: 'resolved' }), f.env)).status, 200);
  assert.equal((await handleRequest(request('/internal/status/incidents', incident), f.env)).status, 409);
  status = await (await handleRequest(request(), f.env)).json() as any;
  assert.equal(status.incidents[0].state, 'resolved'); assert.ok(status.incidents[0].resolved_at);
});

test('scheduled probes persist failures without claiming synthetic provisioning health or launching work', async t => {
  const f = fixture(t), targets: string[] = [];
  await collectStatus(f.env, (async (url: string | URL | Request, options?: RequestInit) => {
    assert.equal(options?.redirect, 'manual');
    targets.push(String(url));
    return String(url).endsWith('/health') ? Response.json({ ok: false }) : new Response('homepage');
  }) as typeof fetch, async () => {});
  const result = await (await handleRequest(request(), f.env)).json() as any;
  assert.equal(result.components.find((c: any) => c.component === 'api').state, 'outage');
  assert.equal(result.components.find((c: any) => c.component === 'website').scope, 'reachability');
  assert.equal(result.components.find((c: any) => c.component === 'auth').scope, 'control_plane');
  assert.equal(result.components.find((c: any) => c.component === 'provisioning').state, 'unknown');
  assert.equal(targets.length, 4);
});

test('history cursors preserve equal timestamps and hide expired evidence before maintenance', async t => {
  const f = fixture(t);
  const checkedAt = new Date(Date.now() - 1000);
  await recordObservations(f.env, Array.from({ length: 105 }, () => ({ component: 'api', state: 'operational', scope: 'reachability' })), checkedAt);
  await recordObservations(f.env, [{ component: 'api', state: 'outage', scope: 'reachability' }], new Date(Date.now() - 32 * 86_400_000));
  const first = await (await handleRequest(request('/status/history?component=api'), f.env)).json() as any;
  assert.equal(first.observations.length, 100);
  const params = new URLSearchParams({ component: 'api', before: first.next.before, beforeId: String(first.next.beforeId) });
  const second = await (await handleRequest(request(`/status/history?${params}`), f.env)).json() as any;
  assert.equal(second.observations.length, 5); assert.equal(second.next, null);
  assert.equal(new Set([...first.observations, ...second.observations].map(o => o.id)).size, 105);
});

test('an older active incident remains visible when recent resolved incidents fill the page', async t => {
  const f = fixture(t);
  await recordObservations(f.env, STATUS_COMPONENTS.map(component => ({ component, state: 'operational', scope: 'synthetic' })));
  const insert = f.sqlite.prepare('INSERT INTO status_incidents (id, component, title, state, message, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const activeId = crypto.randomUUID(), older = new Date(Date.now() - 60_000).toISOString(), now = new Date().toISOString();
  insert.run(activeId, 'api', 'Ongoing disruption', 'investigating', 'Still investigating.', older, older);
  for (let n = 0; n < 50; n++) insert.run(crypto.randomUUID(), 'api', 'Past incident', 'resolved', 'Resolved.', now, now);
  const result = await (await handleRequest(request(), f.env)).json() as any;
  assert.equal(result.state, 'degraded'); assert.equal(result.incidents.length, 50);
  assert.equal(result.incidents[0].id, activeId);
});

test('scheduled reachability treats redirects as failure without following another host', async t => {
  const f = fixture(t); let calls = 0;
  await collectStatus(f.env, (async (_url: RequestInfo | URL, options?: RequestInit) => {
    calls++; assert.equal(options?.redirect, 'manual');
    return new Response(null, { status: 302, headers: { Location: 'https://foreign.example/' } });
  }) as typeof fetch, async () => {});
  const result = await (await handleRequest(request(), f.env)).json() as any;
  assert.equal(calls, 6);
  for (const component of ['website', 'api']) assert.equal(result.components.find((c: any) => c.component === component).state, 'outage');
});

test('scheduled checks recover from deployment interruptions before recording an outage', async t => {
  const f = fixture(t), attempts = new Map<string, number>(), waits: number[] = [];
  await collectStatus(f.env, (async (url: RequestInfo | URL) => {
    const target = String(url), count = (attempts.get(target) ?? 0) + 1;
    attempts.set(target, count);
    if (count === 1) throw new Error('connection reset during deployment');
    if (count === 2) return new Response('temporarily unavailable', { status: 503 });
    return target.endsWith('/health') ? Response.json({ ok: true }) : new Response('homepage');
  }) as typeof fetch, async ms => { waits.push(ms); });
  const result = await (await handleRequest(request(), f.env)).json() as any;
  for (const component of ['website', 'api']) assert.equal(result.components.find((c: any) => c.component === component).state, 'operational');
  assert.deepEqual(waits, [1000, 2000, 1000, 2000]);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS count FROM status_observations WHERE state = 'outage'").get()!.count, 0);
});

test('API Worker enables public fetch routing for its own health probe', () => {
  const config = JSON.parse(readFileSync(new URL('../../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.ok(config.compatibility_flags.includes('global_fetch_strictly_public'));
});

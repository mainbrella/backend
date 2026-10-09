import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleProjectEndpointRequest, handleProjectDomainsRequest } from './project-hosting';
import { normalizeProjectHostname } from '../lib/project-domains';
import { publicIngressIp, projectHostingCapabilities } from '../lib/project-hosting';
import { paidContainerFixture, GENERATION_ONE, GENERATION_TWO, SESSION_ONE, SESSION_TWO, USER_ONE, USER_TWO } from './paid-container-test-helpers';

const PROJECT = '4e3cb127-784d-4a9f-9828-afd093c295dc';
const OTHER_PROJECT = '47dc91ad-2bf1-4248-b177-cec424c4dd16';
const TARGET = { kind: 'container', id: 'small', createdAt: GENERATION_ONE, port: 3000 };
const host = 'site.example.com';
function request(path = 'endpoint', method = 'GET', body?: unknown, session = SESSION_ONE, id = PROJECT, suffix = '') {
  return new Request(`https://api.mainbrella.com/projects/${path}?id=${id}${suffix}`, { method,
    headers: { Origin: 'https://mainbrella.com', Cookie: `mainbrella_session=${session}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const endpoint = handleProjectEndpointRequest;
const domains = handleProjectDomainsRequest;
function database(sqlite: DatabaseSync): D1Database {
  return { prepare(sql: string) {
    let values: unknown[] = [];
    return {
      bind(...args: unknown[]) { values = args; return this; },
      first<T>() { return (sqlite.prepare(sql).get(...values as never[]) as T | undefined) ?? null; },
      all<T>() { return { success: true, results: sqlite.prepare(sql).all(...values as never[]) as T[] }; },
      run() { const result = sqlite.prepare(sql).run(...values as never[]); return { success: true, meta: { changes: Number(result.changes) } }; },
    };
  } } as unknown as D1Database;
}
async function fixture(t: TestContext) {
  const f = await paidContainerFixture(t);
  for (const name of ['014_projects.sql', '015_project_domain.sql', '016_project_domains.sql']) f.sqlite.exec(readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8'));
  const routing = new DatabaseSync(':memory:');
  routing.exec(readFileSync(new URL('../../preview-migrations/002_project_endpoints.sql', import.meta.url), 'utf8'));
  f.env.PREVIEW_ROUTES = database(routing);
  f.env.PREVIEW_DOMAIN = 'mainbrella.dev';
  f.env.PROJECT_HOSTING_ENABLED = 'true';
  f.env.PROJECT_DOMAIN_PROVIDER = 'ingress';
  f.env.PROJECT_APEX_IPS = '8.8.8.8';
  f.env.PROJECT_INGRESS_HOST = 'ingress.mainbrella.dev';
  f.env.PROJECT_INGRESS_SECRET = 's'.repeat(32);
  for (const [id, user] of [[PROJECT, USER_ONE], [OTHER_PROJECT, USER_TWO]]) {
    f.sqlite.prepare('INSERT INTO projects (id,user_id,name,created_at) VALUES (?,?,?,?)').run(id, user, 'Test project', GENERATION_ONE);
  }
  t.after(() => { routing.close(); f.close(); });
  const calls: { name: string; request: Request; body?: any }[] = [];
  const bindings = new Map<string, unknown>();
  let failDelete = false, failPutResponse = false;
  let onPut: ((revision: string) => Promise<void>) | undefined;
  f.env.USER_CONTAINER = { idFromName: (value: string) => value, get(name: string) { return { async fetch(req: Request) {
    const url = new URL(req.url);
    const entry: typeof calls[number] = { name, request: req }; calls.push(entry);
    if (req.method === 'PUT') {
      const body = await req.json() as any; entry.body = body;
      bindings.set(body.revision, { ...body, name });
      if (onPut) await onPut(body.revision);
      if (failPutResponse) throw new Error('lost runtime response');
      return Response.json({ ...body, createdAt: req.headers.get('x-project-created-at') });
    }
    if (failDelete) throw new Error('runtime offline');
    if (!url.searchParams.has('origin')) bindings.delete(url.searchParams.get('revision')!);
    return Response.json({ revoked: true });
  } }; } } as unknown as DurableObjectNamespace<any>;
  const stripeFetch = globalThis.fetch;
  let txt = false, routingDns = false, tls = false, unexpectedIp = false;
  const external: { url: URL; options?: RequestInit }[] = [];
  let providerExists = false, providerActive = false, providerFail = false;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.hostname === 'cloudflare-dns.com') {
      external.push({ url, options });
      const name = url.searchParams.get('name')!, type = url.searchParams.get('type');
      const row = f.sqlite.prepare('SELECT challenge FROM project_domains WHERE hostname = ? ORDER BY created_at LIMIT 1').get(host) as any;
      let Answer: any[] = [];
      if (type === 'TXT' && txt && row) Answer = [{ name, type: 16, data: `"${row.challenge}"` }];
      if (type === 'A' && routingDns) Answer = [{ name, type: 1, data: unexpectedIp ? '127.0.0.1' : '8.8.8.8' }];
      return Response.json({ Status: 0, Answer });
    }
    if (url.hostname === host) { external.push({ url, options }); return new Response(tls ? (f.sqlite.prepare('SELECT challenge FROM project_domains WHERE hostname = ?').get(host) as any)?.challenge : 'not ready'); }
    if (url.hostname === 'api.cloudflare.com') {
      external.push({ url, options });
      if (providerFail) throw new Error('private token detail');
      if (options?.method === 'DELETE') { providerExists = false; return Response.json({ success: true, result: { id: 'provider-one' } }); }
      const result = { id: 'provider-one', hostname: host, status: providerActive ? 'active' : 'pending', ssl: { status: providerActive ? 'active' : 'pending_validation' } };
      if (url.search) return Response.json({ success: true, result: providerExists ? [result] : [] });
      providerExists = true;
      return Response.json({ success: true, result });
    }
    return stripeFetch(input, options);
  });
  return { ...f, routing, calls, bindings, external,
    setDeleteFailure(value: boolean) { failDelete = value; }, setLostPut(value: boolean) { failPutResponse = value; },
    setOnPut(value?: (revision: string) => Promise<void>) { onPut = value; },
    setDns(ownership: boolean, routing: boolean, active = false, unsafeIp = false) { txt = ownership; routingDns = routing; tls = active; unexpectedIp = unsafeIp; },
    setProvider(active: boolean, failure = false, exists = false) { providerActive = active; providerFail = failure; providerExists = exists; },
  };
}
async function addDomain(f: Awaited<ReturnType<typeof fixture>>, hostname = host, project = PROJECT, session = SESSION_ONE) {
  const response = await domains(request('domains', 'POST', { hostname }, session, project), f.env);
  assert.equal(response.status, 201);
  return (await response.json() as any).domain;
}
const verify = (domainId: string, session = SESSION_ONE, project = PROJECT) => request('domains/verify', 'POST', undefined, session, project, `&domainId=${domainId}`);

test('endpoint publishes exact owned generation, switches revision, exposes stable identity and unpublishes without deleting domains', async t => {
  const f = await fixture(t);
  const domain = await addDomain(f);
  const initial = await (await endpoint(request(), f.env)).json() as any;
  assert.equal(initial.endpoint.backendStatus, 'unlinked');
  assert.equal(initial.endpoint.url, `https://p-${PROJECT.replaceAll('-', '')}.mainbrella.dev/`);
  assert.equal((await endpoint(request('endpoint', 'PUT', { target: TARGET }), f.env)).status, 200);
  const first = f.routing.prepare('SELECT * FROM project_endpoints').get() as any;
  assert.equal(first.user_id, USER_ONE); assert.equal(first.created_at, GENERATION_ONE); assert.equal(first.container_name, 'user:account-one');
  assert.deepEqual(JSON.parse(first.target_json), TARGET);
  assert.equal((await endpoint(request('endpoint', 'PUT', { target: { ...TARGET, port: 8080 } }), f.env)).status, 200);
  const second = f.routing.prepare('SELECT * FROM project_endpoints').get() as any;
  assert.notEqual(second.revision, first.revision); assert.equal(f.bindings.has(first.revision), false); assert.equal(f.bindings.size, 1);
  f.env.PROJECT_HOSTING_ENABLED = 'false';
  assert.equal((await endpoint(request('endpoint', 'PUT', { target: TARGET }), f.env)).status, 503);
  assert.equal((await endpoint(request(), f.env)).status, 200);
  const removed = await (await endpoint(request('endpoint', 'DELETE'), f.env)).json() as any;
  assert.equal(removed.endpoint.backendStatus, 'unlinked'); assert.equal(removed.domains[0].id, domain.id);
  assert.equal(f.bindings.size, 0); assert.equal(f.routing.prepare('SELECT * FROM project_endpoints').get(), undefined);
  assert.equal((await endpoint(request('endpoint', 'DELETE'), f.env)).status, 200);
});

test('authentication, project ownership, trusted mutation origins, bounded payloads and exact paid generations are required', async t => {
  const f = await fixture(t);
  assert.equal((await endpoint(request('endpoint', 'PUT', { target: TARGET }, SESSION_TWO), f.env)).status, 404);
  assert.equal((await endpoint(request('endpoint', 'GET', undefined, 'missing'), f.env)).status, 401);
  const noOrigin = request('endpoint', 'PUT', { target: TARGET }); noOrigin.headers.delete('Origin');
  assert.equal((await endpoint(noOrigin, f.env)).status, 403);
  const badOrigin = request('endpoint', 'DELETE'); badOrigin.headers.set('Origin', 'https://attacker.example');
  assert.equal((await endpoint(badOrigin, f.env)).status, 403);
  for (const target of [{ ...TARGET, port: 22 }, { ...TARGET, port: 65536 }, { ...TARGET, extra: true }, { kind: 'network', network: 'bad space', service: 'app' }]) {
    assert.equal((await endpoint(request('endpoint', 'PUT', { target }), f.env)).status, 400);
  }
  assert.equal((await endpoint(request('endpoint', 'PUT', { target: { ...TARGET, createdAt: GENERATION_TWO } }), f.env)).status, 409);
  assert.equal((await endpoint(request('endpoint', 'PUT', { target: TARGET, payload: 'x'.repeat(1024) }), f.env)).status, 413);
  assert.equal((await endpoint(request('endpoint', 'GET', undefined, SESSION_ONE, PROJECT, `&id=${PROJECT}`), f.env)).status, 400);
  f.setBillingMode('unpaid');
  assert.equal((await endpoint(request('endpoint', 'PUT', { target: TARGET }), f.env)).status, 402);
  assert.equal(f.calls.length, 0);
});

test('replacement container generations become unavailable and inspection/removal remain usable without subscription', async t => {
  const f = await fixture(t);
  await endpoint(request('endpoint', 'PUT', { target: TARGET }), f.env);
  f.containers.get(USER_ONE)![0].createdAt = GENERATION_TWO;
  assert.equal((await (await endpoint(request(), f.env)).json() as any).endpoint.backendStatus, 'unavailable');
  f.setBillingMode('unpaid');
  assert.equal((await endpoint(request('endpoint', 'DELETE'), f.env)).status, 200);
  assert.equal(f.calls.at(-1)?.request.headers.get('x-project-created-at'), GENERATION_ONE);
});

test('lost runtime responses and ambiguous index writes clean up only the attempted revision', async t => {
  const f = await fixture(t);
  f.setLostPut(true);
  assert.equal((await endpoint(request('endpoint', 'PUT', { target: TARGET }), f.env)).status, 503);
  assert.equal(f.bindings.size, 0);
  f.setLostPut(false);
  const original = f.env.PREVIEW_ROUTES!;
  for (const ambiguous of [false, true]) {
    f.env.PREVIEW_ROUTES = { prepare(sql: string) {
      const stmt = original.prepare(sql);
      if (!sql.startsWith('INSERT INTO project_endpoints')) return stmt;
      return { bind(...args: unknown[]) { const bound = stmt.bind(...args); return { async run() { if (ambiguous) await bound.run(); throw new Error('lost database response'); } }; } };
    } } as unknown as D1Database;
    assert.equal((await endpoint(request('endpoint', 'PUT', { target: TARGET }), f.env)).status, 503);
    assert.equal(f.routing.prepare('SELECT * FROM project_endpoints').get(), undefined); assert.equal(f.bindings.size, 0);
  }
});

test('partial revoke retains exact-generation journal, disables route and reconciles after an issuance flag change', async t => {
  const f = await fixture(t);
  await endpoint(request('endpoint', 'PUT', { target: TARGET }), f.env);
  f.setDeleteFailure(true);
  const response = await endpoint(request('endpoint', 'DELETE'), f.env);
  assert.equal(response.status, 503); assert.equal((await response.json() as any).error, 'project_reconciliation_required');
  assert.equal(f.routing.prepare('SELECT * FROM project_endpoints').get(), undefined);
  assert.ok(f.routing.prepare('SELECT * FROM project_binding_operations').get());
  f.env.PROJECT_HOSTING_ENABLED = 'false'; f.setDeleteFailure(false);
  assert.equal((await endpoint(request('endpoint', 'DELETE'), f.env)).status, 200);
  assert.equal(f.bindings.size, 0); assert.equal(f.routing.prepare('SELECT * FROM project_binding_operations').get(), undefined);
});

test('fencing prevents delayed publication from overriding a newer publication or owner unpublish', async t => {
  const f = await fixture(t);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  f.setOnPut(async () => { if (first) { first = false; entered(); await blocked; } });
  const older = endpoint(request('endpoint', 'PUT', { target: TARGET }), f.env);
  await started;
  assert.equal((await endpoint(request('endpoint', 'PUT', { target: { ...TARGET, port: 8080 } }), f.env)).status, 200);
  release(); assert.equal((await older).status, 409);
  assert.equal((f.routing.prepare('SELECT * FROM project_endpoints').get() as any).port, 8080);
  assert.equal(f.bindings.size, 1);
  let entered2!: () => void, release2!: () => void;
  const started2 = new Promise<void>(resolve => { entered2 = resolve; });
  const blocked2 = new Promise<void>(resolve => { release2 = resolve; });
  f.setOnPut(async () => { entered2(); await blocked2; });
  const pending = endpoint(request('endpoint', 'PUT', { target: TARGET }), f.env);
  await started2;
  assert.equal((await endpoint(request('endpoint', 'DELETE'), f.env)).status, 200);
  release2(); assert.equal((await pending).status, 409);
  assert.equal(f.routing.prepare('SELECT * FROM project_endpoints').get(), undefined); assert.equal(f.bindings.size, 0);
});

test('domain registration canonicalizes hostnames, never reserves unverified names, and scopes owner records', async t => {
  const f = await fixture(t);
  const added = await addDomain(f, 'SITE.EXAMPLE.COM.');
  assert.equal(added.hostname, host); assert.equal(added.status, 'pending_dns'); assert.equal(f.routing.prepare('SELECT * FROM project_hosts').get(), undefined);
  assert.deepEqual(added.dnsRecords.map((r: any) => r.type), ['TXT', 'A']);
  assert.equal((await addDomain(f)).id, added.id);
  const other = await addDomain(f, host, OTHER_PROJECT, SESSION_TWO);
  assert.notEqual(other.id, added.id); assert.equal((await (await domains(request('domains', 'GET', undefined, SESSION_TWO, OTHER_PROJECT), f.env)).json() as any).domains.length, 1);
  assert.equal((await domains(verify(added.id, SESSION_TWO), f.env)).status, 404);
  for (const value of ['https://example.com', 'example.com:443', '*.example.com', '127.0.0.1', 'mainbrella.com', 'app.mainbrella.com', 'mainbrella.dev', 'foo.mainbrella.dev', 'foo.internal']) assert.equal(normalizeProjectHostname(value, f.env), null, value);
  assert.equal(normalizeProjectHostname('BÜCHER.example'), 'xn--bcher-kva.example');
});

test('TXT ownership and routing are independently required; TLS activation requires a safe DNS set and HTTPS token', async t => {
  const f = await fixture(t); const added = await addDomain(f);
  f.setDns(false, true, true);
  assert.equal((await domains(verify(added.id), f.env)).status, 200); assert.equal(f.routing.prepare('SELECT * FROM project_hosts').get(), undefined);
  f.setDns(true, false, true);
  assert.equal((await domains(verify(added.id), f.env)).status, 200); assert.equal(f.routing.prepare('SELECT * FROM project_hosts').get(), undefined);
  f.setDns(true, true);
  const pending = await (await domains(verify(added.id), f.env)).json() as any;
  assert.equal(pending.domain.status, 'pending_tls'); assert.equal(pending.domain.dnsStatus, 'verified'); assert.equal((f.routing.prepare('SELECT * FROM project_hosts').get() as any).status, 'pending_tls');
  f.setDns(true, true, true);
  assert.equal((await (await domains(verify(added.id), f.env)).json() as any).domain.status, 'active');
  f.setDns(true, true, true, true); f.external.length = 0;
  assert.equal((await (await domains(verify(added.id), f.env)).json() as any).domain.status, 'pending_dns');
  assert.equal(f.external.some(call => call.url.hostname === host), false); assert.equal(f.routing.prepare('SELECT * FROM project_hosts').get(), undefined);
});

test('a verified hostname has a unique project claim; other owners cannot remove or overwrite it', async t => {
  const f = await fixture(t); const added = await addDomain(f); const other = await addDomain(f, host, OTHER_PROJECT, SESSION_TWO);
  f.setDns(true, true, true);
  await domains(verify(added.id), f.env);
  // Simulate public DNS being changed to the other owner's exact TXT proof.
  f.sqlite.prepare('UPDATE project_domains SET challenge = (SELECT challenge FROM project_domains WHERE id = ?) WHERE id = ?').run(added.id, other.id);
  const conflict = await domains(verify(other.id, SESSION_TWO, OTHER_PROJECT), f.env);
  assert.equal(conflict.status, 409); assert.equal((await conflict.json() as any).error, 'domain_in_use');
  assert.equal((await domains(request('domains', 'DELETE', undefined, SESSION_TWO, OTHER_PROJECT, `&domainId=${other.id}`), f.env)).status, 200);
  assert.equal((f.routing.prepare('SELECT * FROM project_hosts').get() as any).project_id, PROJECT);
});

test('domain removal revokes only that origin, preserves endpoint, works with provider disabled and supports retries', async t => {
  const f = await fixture(t); const added = await addDomain(f); f.setDns(true, true, true);
  await domains(verify(added.id), f.env); await endpoint(request('endpoint', 'PUT', { target: TARGET }), f.env);
  f.env.PROJECT_DOMAIN_PROVIDER = 'disabled'; f.setDeleteFailure(true);
  const remove = () => domains(request('domains', 'DELETE', undefined, SESSION_ONE, PROJECT, `&domainId=${added.id}`), f.env);
  assert.equal((await remove()).status, 503); assert.equal((f.routing.prepare('SELECT * FROM project_hosts').get() as any).status, 'disabled');
  f.setDeleteFailure(false); assert.equal((await remove()).status, 200);
  assert.equal(f.routing.prepare('SELECT * FROM project_hosts').get(), undefined); assert.ok(f.routing.prepare('SELECT * FROM project_endpoints').get()); assert.equal(f.bindings.size, 1);
  assert.equal(new URL(f.calls.at(-1)!.request.url).searchParams.get('origin'), `https://${host}`);
});

test('Cloudflare provisioning starts only after proof, reconciles an existing provider hostname and requires both activation statuses', async t => {
  const f = await fixture(t);
  f.env.PROJECT_DOMAIN_PROVIDER = 'cloudflare'; f.env.PROJECT_CLOUDFLARE_ZONE_ID = 'zone123'; f.env.PROJECT_CLOUDFLARE_API_TOKEN = 'private-token';
  const added = await addDomain(f); assert.equal(added.dnsRecords[1].type, 'CNAME');
  await domains(verify(added.id), f.env); assert.equal(f.external.some(call => call.url.hostname === 'api.cloudflare.com'), false);
  f.setDns(true, true); f.setProvider(false, false, true);
  const pending = await (await domains(verify(added.id), f.env)).json() as any;
  assert.equal(pending.domain.status, 'pending_tls'); assert.equal(f.external.some(call => call.url.hostname === 'api.cloudflare.com' && call.options?.method === 'POST'), false);
  assert.equal((f.sqlite.prepare('SELECT provider_id FROM project_domains').get() as any).provider_id, 'provider-one');
  f.setProvider(true); assert.equal((await (await domains(verify(added.id), f.env)).json() as any).domain.status, 'active');
  f.setProvider(true, true);
  const failure = await domains(verify(added.id), f.env); assert.equal(failure.status, 503); assert.ok(!JSON.stringify(await failure.json()).includes('private-token'));
  assert.equal((f.routing.prepare('SELECT * FROM project_hosts').get() as any).status, 'pending_tls');
});

test('custom-domain enablement and configured public ingress addresses fail closed', async t => {
  const f = await fixture(t);
  assert.equal(projectHostingCapabilities(f.env).customDomains, true);
  for (const value of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '172.16.0.1', '100.64.0.1', '224.0.0.1', '::1', 'fd00::1', '2001:db8::1']) assert.equal(publicIngressIp(value), false, value);
  assert.equal(publicIngressIp('8.8.8.8'), true); assert.equal(publicIngressIp('2606:4700:4700::1111'), true);
  f.env.PROJECT_INGRESS_SECRET = 'short'; assert.equal(projectHostingCapabilities(f.env).customDomains, false);
  f.env.PROJECT_INGRESS_SECRET = 's'.repeat(32); f.env.PROJECT_INGRESS_HOST = 'https://ingress.example'; assert.equal(projectHostingCapabilities(f.env).customDomains, false);
  assert.equal((await domains(request('domains', 'POST', { hostname: host }), f.env)).status, 503);
});

test('account migrations enforce project foreign keys while routing schema contains no account/session tables', async t => {
  const f = await fixture(t); await addDomain(f);
  f.sqlite.prepare('DELETE FROM users WHERE id = ?').run(USER_ONE);
  assert.equal((f.sqlite.prepare('SELECT count(*) AS count FROM project_domains').get() as any).count, 0);
  const names = f.routing.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row: any) => row.name);
  assert.ok(!names.includes('users')); assert.ok(!names.includes('sessions'));
});

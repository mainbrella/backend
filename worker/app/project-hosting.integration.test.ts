import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { paidContainerFixture, SESSION_ONE, SESSION_TWO, USER_ONE } from './paid-container-test-helpers';
import { handleRequest } from './router';
import { handleApplicationGateway } from '../preview-gateway';
// The private container runtime is intentionally JavaScript, as its existing
// transport implementations are. Exercise it directly across the API boundary.
// @ts-expect-error Runtime module has no TypeScript declarations.
import { ContainerProjectIngress } from '../../containers/project-ingress.js';

function database(sqlite: DatabaseSync): D1Database {
  return { prepare(sql: string) {
    let args: unknown[] = [];
    return {
      bind(...values: unknown[]) { args = values; return this; },
      first<T>() { return sqlite.prepare(sql).get(...args as never[]) as T ?? null; },
      all<T>() { return { results: sqlite.prepare(sql).all(...args as never[]) as T[] }; },
      run() { const result = sqlite.prepare(sql).run(...args as never[]); return { success: true, meta: { changes: Number(result.changes) } }; },
    };
  } } as unknown as D1Database;
}

test('project publication, domain DNS/TLS, app cookies and cleanup work across the real API/gateway/runtime contracts', async t => {
  const f = await paidContainerFixture(t);
  t.after(() => f.close());
  const routing = new DatabaseSync(':memory:');
  t.after(() => routing.close());
  for (const path of ['014_projects.sql', '015_project_domain.sql', '016_project_domains.sql']) {
    f.sqlite.exec(readFileSync(new URL(`../../migrations/${path}`, import.meta.url), 'utf8'));
  }
  for (const path of ['001_preview_routes.sql', '002_project_endpoints.sql']) {
    routing.exec(readFileSync(new URL(`../../preview-migrations/${path}`, import.meta.url), 'utf8'));
  }
  const generation = f.generationFor(USER_ONE);
  const metadata = { createdAt: Date.parse(generation), expiresAt: Date.now() + 1_800_000 };
  const values = new Map<string, unknown>([['builderMachine', metadata]]);
  let running = true;
  const applications: Request[] = [];
  const controller = {
    ctx: { storage: { async get(key: string) { return values.get(key); }, async put(key: string, value: unknown) { values.set(key, value); } } },
    container: { get running() { return running; }, getTcpPort(port: number) { assert.equal(port, 3000); return { async fetch(request: Request) {
      applications.push(request);
      return Response.json({ host: request.headers.get('host'), authorization: request.headers.get('authorization'), cookie: request.headers.get('cookie') },
        { headers: { 'set-cookie': 'app_session=ok; Domain=.mainbrella.dev; HttpOnly; Secure' } });
    } }; } },
    now: Date.now, deadline: (value: typeof metadata) => value.expiresAt,
    hasPaidAccess: async () => true, serialized: async (fn: () => unknown) => fn(),
    respond: (body: unknown, status = 200) => Response.json(body, { status }),
    getTerminalMetadata: async () => running ? metadata : null, touchTerminalActivity: async () => running,
  };
  const runtime = new ContainerProjectIngress(controller);
  t.after(() => runtime.close());
  const env = { ...f.env, PREVIEW_ROUTES: database(routing), PREVIEW_DOMAIN: 'mainbrella.dev', PROJECT_HOSTING_ENABLED: 'true',
    PROJECT_DOMAIN_PROVIDER: 'ingress', PROJECT_APEX_IPS: '8.8.8.8', PROJECT_INGRESS_HOST: 'ingress.mainbrella.dev', PROJECT_INGRESS_SECRET: 'test-only-secret-'.repeat(3),
    USER_CONTAINER: { idFromName: (name: string) => name, get(name: string) {
      assert.equal(name, `user:${USER_ONE}`);
      return { fetch: (request: Request) => new URL(request.url).pathname === '/project-bindings' ? runtime.manage(request) : runtime.forward(request) };
    } },
  } as unknown as Env;
  const api = (path: string, method = 'GET', body?: unknown, session = SESSION_ONE) => handleRequest(new Request(`https://api.mainbrella.com${path}`, {
    method, headers: { Origin: 'https://mainbrella.com', Cookie: `mainbrella_session=${session}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
  const created = await (await api('/projects', 'POST', { name: 'Connected project' })).json() as any;
  const id = created.project.id;
  const target = { kind: 'container', id: 'small', createdAt: generation, port: 3000 };
  assert.equal((await api(`/projects/endpoint?id=${id}`, 'PUT', { target }, SESSION_TWO)).status, 404);
  const publish = await api(`/projects/endpoint?id=${id}`, 'PUT', { target });
  assert.equal(publish.status, 200);
  const state = await publish.json() as any;
  const response = await handleApplicationGateway(new Request(state.endpoint.url, { headers: { authorization: 'Bearer app-secret', cookie: 'mainbrella_session=account; app_session=app' } }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { host: new URL(state.endpoint.url).hostname, authorization: 'Bearer app-secret', cookie: 'app_session=app' });
  assert.equal(response.headers.get('set-cookie'), 'app_session=ok; HttpOnly; Secure');
  const registration = await (await api(`/projects/domains?id=${id}`, 'POST', { hostname: 'site.example.com' })).json() as any;
  const domain = registration.domain;
  const token = domain.dnsRecords.find((record: any) => record.purpose === 'ownership').value;
  const stripeFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.hostname === 'cloudflare-dns.com') {
      const name = url.searchParams.get('name')!;
      const type = url.searchParams.get('type');
      return Response.json({ Status: 0, Answer: type === 'TXT' ? [{ name, type: 16, data: JSON.stringify(token) }]
        : type === 'A' ? [{ name, type: 1, data: '8.8.8.8' }] : [] });
    }
    if (url.hostname === 'site.example.com') return handleApplicationGateway(new Request(`https://ingress.mainbrella.dev${url.pathname}`, { headers: {
      'x-project-ingress-secret': env.PROJECT_INGRESS_SECRET!, 'x-project-original-host': url.hostname,
    } }), env);
    return stripeFetch(input, init);
  });
  const verified = await api(`/projects/domains/verify?id=${id}&domainId=${domain.id}`, 'POST');
  assert.equal(verified.status, 200);
  assert.equal((await verified.json() as any).domain.status, 'active');
  const custom = await handleApplicationGateway(new Request('https://site.example.com/path?q=1'), env);
  assert.equal(custom.status, 200);
  assert.equal((await custom.json() as any).host, 'site.example.com');
  assert.equal(applications.at(-1)!.url, 'http://container/path?q=1');
  running = false;
  runtime.close();
  const cleanup = await api(`/projects/endpoint?id=${id}`, 'DELETE');
  assert.equal(cleanup.status, 200, await cleanup.clone().text());
  assert.equal((await cleanup.json() as any).endpoint.backendStatus, 'unlinked');
  assert.equal((await handleApplicationGateway(new Request(state.endpoint.url), env)).status, 404);
  const removed = await api(`/projects/domains?id=${id}&domainId=${domain.id}`, 'DELETE');
  assert.equal(removed.status, 200);
  assert.equal((await removed.json() as any).domains.length, 0);
  assert.equal((await handleApplicationGateway(new Request('https://site.example.com'), env)).status, 404);
});

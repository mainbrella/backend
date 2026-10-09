import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { paidContainerFixture, SESSION_ONE, SESSION_TWO, USER_ONE } from './paid-container-test-helpers';
import { handleRequest } from './router';
import { handleApplicationGateway } from '../preview-gateway';
import worker from '../index';
import { createServer } from 'node:http';
import { once } from 'node:events';
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

test('local API entrypoint publishes and activates loopback aliases with real HTTP application transport', async t => {
  const httpFetch = globalThis.fetch;
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
  const applicationRequests: { host?: string; cookie?: string; auth?: string; proto?: string }[] = [];
  const application = createServer((request, response) => {
    applicationRequests.push({ host: request.headers.host, cookie: request.headers.cookie, auth: request.headers.authorization,
      proto: request.headers['x-forwarded-proto'] as string });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ path: request.url, host: request.headers.host }));
  });
  application.listen(0, '127.0.0.1'); await once(application, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => application.close(error => error ? reject(error) : resolve())));
  const applicationPort = (application.address() as { port: number }).port;
  const generation = f.generationFor(USER_ONE);
  const metadata = { createdAt: Date.parse(generation), expiresAt: Date.now() + 1_800_000 };
  const values = new Map<string, unknown>([['builderMachine', metadata]]);
  // The fixture mocks billing fetches; only the runtime's app hop uses real TCP.
  const controller = {
    ctx: { storage: { async get(key: string) { return values.get(key); }, async put(key: string, value: unknown) { values.set(key, value); } } },
    container: { running: true, getTcpPort(port: number) {
      assert.equal(port, applicationPort);
      return { fetch(request: Request) {
        const target = new URL(request.url); target.hostname = '127.0.0.1'; target.port = String(applicationPort);
        return httpFetch(target, { method: request.method, headers: Object.fromEntries(request.headers),
          signal: request.signal, redirect: 'manual' });
      } };
    } },
    now: Date.now, deadline: (value: typeof metadata) => value.expiresAt,
    hasPaidAccess: async () => true, serialized: async (fn: () => unknown) => fn(),
    respond: (body: unknown, status = 200) => Response.json(body, { status }),
    getTerminalMetadata: async () => metadata, touchTerminalActivity: async () => true,
  };
  const runtime = new ContainerProjectIngress(controller, { allowLocal: true });
  t.after(() => runtime.close());
  const revocations: string[] = [];
  const env = { ...f.env, PREVIEW_ROUTES: database(routing), LOCAL_DEV: 'true', LOCAL_PREVIEW_PORT: '8899',
    PROJECT_HOSTING_ENABLED: 'true', PROJECT_DOMAIN_PROVIDER: 'local',
    USER_CONTAINER: { idFromName: (name: string) => name, get(name: string) {
      assert.equal(name, `user:${USER_ONE}`);
      return { fetch: (request: Request) => {
        const url = new URL(request.url);
        if (request.method === 'DELETE' && url.searchParams.has('origin')) revocations.push(url.searchParams.get('origin')!);
        return url.pathname === '/project-bindings' ? runtime.manage(request) : runtime.forward(request);
      } };
    } },
  } as unknown as Env;
  const api = (path: string, method = 'GET', body?: unknown, session = SESSION_ONE) => worker.fetch(new Request(`http://localhost:8899${path}`, {
    method, headers: { Origin: 'http://localhost:5173', Cookie: `mainbrella_session=${session}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, {} as ExecutionContext);
  const created = await (await api('/projects', 'POST', { name: 'Local connected project' })).json() as any;
  const id = created.project.id;
  const publish = await api(`/projects/endpoint?id=${id}`, 'PUT', { target: { kind: 'container', id: 'small', createdAt: generation, port: applicationPort } });
  assert.equal(publish.status, 200, await publish.clone().text());
  const state = await publish.json() as any;
  assert.equal(state.hosting.localDevelopment, true);
  assert.equal(state.endpoint.url, `http://p-${id.replaceAll('-', '')}.localhost:8899/`);
  const appRequest = (origin: string) => worker.fetch(new Request(`${origin}path?q=1`, { headers: {
    authorization: 'Bearer app-secret', cookie: 'mainbrella_session=account; app_session=app',
  } }), env, {} as ExecutionContext);
  assert.equal((await appRequest(state.endpoint.url)).status, 200);
  const added = await api(`/projects/domains?id=${id}`, 'POST', { hostname: 'app.localhost' });
  assert.equal(added.status, 201, await added.clone().text());
  const domain = (await added.json() as any).domain;
  assert.equal(domain.status, 'pending_dns');
  assert.equal((await appRequest('http://app.localhost:8899/')).status, 404);
  assert.equal((await api(`/projects/domains/verify?id=${id}&domainId=${domain.id}`, 'POST', undefined, SESSION_TWO)).status, 404);
  const verify = () => api(`/projects/domains/verify?id=${id}&domainId=${domain.id}`, 'POST');
  assert.equal((await (await verify()).json() as any).domain.status, 'pending_tls');
  assert.equal((await appRequest('http://app.localhost:8899/')).status, 404);
  assert.equal((await (await verify()).json() as any).domain.status, 'active');
  const response = await appRequest('http://app.localhost:8899/');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { path: '/path?q=1', host: 'app.localhost:8899' });
  assert.deepEqual(applicationRequests.at(-1), { host: 'app.localhost:8899', cookie: 'app_session=app', auth: 'Bearer app-secret', proto: 'http' });
  const removed = await api(`/projects/domains?id=${id}&domainId=${domain.id}`, 'DELETE');
  assert.equal(removed.status, 200, await removed.clone().text());
  assert.deepEqual(revocations, ['http://app.localhost:8899']);
  assert.equal((await appRequest('http://app.localhost:8899/')).status, 404);
  assert.equal((await appRequest(state.endpoint.url)).status, 200);
  assert.equal((await api(`/projects/endpoint?id=${id}`, 'DELETE')).status, 200);
  assert.equal((await appRequest(state.endpoint.url)).status, 404);
});

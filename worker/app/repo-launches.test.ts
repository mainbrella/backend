import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleRequest } from './router';
import { paidContainerFixture, SESSION_ONE, SESSION_TWO, USER_ONE, USER_TWO } from './paid-container-test-helpers';
import { cloneCommand, launchOptionsSchema, previewCommand, setupCommand } from '../lib/repo-launch';
import type { RepoLaunch } from './repo-launches';
import { sealGithubCredentials } from '../lib/github-import';
const commit = 'a'.repeat(40), tree = 'b'.repeat(40);
const defaultOptions = { repo: 'acme/demo' };
const api = (path: string, method = 'GET', body?: unknown, key = 'launch-one', session = SESSION_ONE, origin: string | null = 'https://mainbrella.com') => new Request(`https://api.mainbrella.com${path}`, {
  method, headers: { Cookie: `mainbrella_session=${session}`, ...(origin ? { Origin: origin } : {}),
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), 'Idempotency-Key': key },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});
async function fixture(t: TestContext) {
  const f = await paidContainerFixture(t, { [USER_ONE]: [], [USER_TWO]: [] });
  t.after(() => f.close());
  for (const migration of ['013_repo_launches.sql', '021_acquisition.sql', '022_acquisition_sources.sql', '028_github_import.sql'])
    f.sqlite.exec(readFileSync(new URL(`../../migrations/${migration}`, import.meta.url), 'utf8'));
  Object.assign(f.env, { GITHUB_IMPORT_CLIENT_ID: 'test-client', GITHUB_IMPORT_CLIENT_SECRET: 'test-secret',
    GITHUB_IMPORT_APP_SLUG: 'mainbrella-import', GITHUB_IMPORT_ENCRYPTION_KEY: 'e'.repeat(64) });
  const billingFetch = globalThis.fetch;
  let githubMode = 'public';
  let manifests = ['package.json'];
  const githubCalls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.hostname !== 'api.github.com') return billingFetch(input);
    githubCalls.push(url.href);
    if (githubMode === 'limited') return Response.json({}, { status: 403 });
    if (githubMode === 'missing') return Response.json({}, { status: 404 });
    if (url.pathname.includes('/commits/')) return Response.json({ sha: commit, commit: { tree: { sha: tree } } });
    if (url.pathname.includes('/git/trees/')) return Response.json({ tree: manifests.map(path => ({ path, type: 'blob' })) });
    return Response.json({ full_name: 'acme/demo', private: githubMode === 'private', default_branch: 'main' });
  });
  const executions = new Map<string, { id: string; status: string; stdout: string; stderr: string }>();
  const executionKeys = new Map<string, string>();
  const executionCalls: Request[] = [];
  const uploadedFiles = new Map<string, Uint8Array>();
  let loseExecution = false;
  f.env.USER_CONTAINER = {
    idFromName(name: string) { f.machineNames.push(name); return name; },
    get(name: string) { return { async fetch(request: Request) {
      f.machineCalls.push({ name, request }); executionCalls.push(request);
      if (request.method === 'PUT') {
        const path = new URL(request.url).searchParams.get('path')!;
        uploadedFiles.set(path, new Uint8Array(await request.arrayBuffer()));
        return Response.json({ path });
      }
      if (request.method === 'POST') {
        const key = request.headers.get('Idempotency-Key')!;
        let id = executionKeys.get(key);
        if (!id) { id = crypto.randomUUID(); executionKeys.set(key, id); executions.set(id, { id, status: 'running', stdout: '', stderr: '' }); }
        if (loseExecution) { loseExecution = false; throw new Error('lost_response'); }
        return Response.json(executions.get(id), { status: 202 });
      }
      const execution = executions.get(new URL(request.url).pathname.split('/').at(-1)!);
      return execution ? Response.json(execution) : Response.json({ error: 'execution_not_found' }, { status: 404 });
    } }; },
  } as unknown as Env['USER_CONTAINER'];
  const accountGet = f.env.CONTAINER_ACCOUNT.get.bind(f.env.CONTAINER_ACCOUNT);
  const creations = new Map<string, any>();
  let loseAllocation = false;
  f.env.CONTAINER_ACCOUNT.get = ((name: DurableObjectId) => {
    const original = accountGet(name);
    return { async fetch(request: Request) {
      if (request.method !== 'POST') return original.fetch(request);
      const key = request.headers.get('Idempotency-Key')!;
      let data = creations.get(key);
      if (!data) {
        const response = await original.fetch(request);
        data = await response.json() as any;
        if (!response.ok) return Response.json(data, { status: response.status });
        const container = data.containers.at(-1);
        data.creation = { containerId: container.id, createdAt: container.createdAt };
        creations.set(key, data);
      }
      if (loseAllocation) { loseAllocation = false; throw new Error('lost_response'); }
      return Response.json(data);
    } };
  }) as typeof f.env.CONTAINER_ACCOUNT.get;
  const create = async (options = defaultOptions, key = 'launch-one', session = SESSION_ONE) => {
    const response = await handleRequest(api('/repo-launches', 'POST', options, key, session), f.env);
    assert.ok(response.ok, JSON.stringify(await response.clone().json()));
    return response.json() as Promise<RepoLaunch>;
  };
  const step = async (state: RepoLaunch) => {
    const response = await handleRequest(api(`/repo-launches/${state.id}/advance`, 'POST'), f.env);
    assert.ok(response.ok, JSON.stringify(await response.clone().json()));
    return response.json() as Promise<RepoLaunch>;
  };
  const complete = (state: RepoLaunch, phase: 'cloning' | 'setup' | 'starting', status = 'succeeded') => { executions.get(state.executions[phase]!)!.status = status; };
  const mutate = (state: RepoLaunch) => f.sqlite.prepare('UPDATE repo_launches SET state_json = ? WHERE id = ?').run(JSON.stringify(state), state.id);
  return { ...f, create, step, complete, mutate, githubCalls, executions, executionKeys, executionCalls, creations, uploadedFiles,
    githubMode(value: string) { githubMode = value; }, manifests(value: string[]) { manifests = value; }, loseAllocation() { loseAllocation = true; }, loseExecution() { loseExecution = true; } };
}

test('missing launch migration logs the database error and failing stage without exposing diagnostics to callers', async t => {
  const f = await fixture(t);
  const logs: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(args); });
  f.sqlite.exec('DROP TABLE repo_launches');
  const response = await handleRequest(api('/repo-launches', 'POST', defaultOptions), f.env);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'launch_unavailable' });
  const details = logs.find(([event]) => event === 'repo_launch_request_failed')![1] as any;
  assert.match(details.requestId, /^[a-f0-9-]{36}$/);
  assert.equal(details.stage, 'load_existing_launch');
  assert.equal(details.method, 'POST'); assert.equal(details.path, '/repo-launches');
  assert.equal(details.status, 503); assert.ok(details.elapsedMs >= 0);
  assert.match(details.error.message, /no such table: repo_launches/);
  assert.ok(details.error.stack);
  assert.ok(!JSON.stringify(logs).includes(SESSION_ONE));
});

test('GitHub failures log upstream status, message, request ID and rate limit headers', async t => {
  const f = await fixture(t);
  const logs: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(args); });
  const delegate = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.hostname !== 'api.github.com') return delegate(input);
    return Response.json({ message: 'API rate limit exceeded' }, { status: 403, headers: {
      'x-github-request-id': 'github-request-123', 'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': '1791500000', 'retry-after': '60',
    } });
  });
  const response = await handleRequest(api('/repo-launches', 'POST', defaultOptions), f.env);
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: 'github_rate_limited' });
  const details = logs.find(([event]) => event === 'repo_launch_request_failed')![1] as any;
  assert.equal(details.stage, 'resolve_repository');
  assert.deepEqual(details.error.diagnostics, { dependency: 'github', operation: 'repository', upstreamStatus: 403,
    upstreamRequestId: 'github-request-123', rateLimitRemaining: '0', rateLimitReset: '1791500000',
    retryAfter: '60', upstreamMessage: 'API rate limit exceeded' });
  assert.equal(f.accountCalls.length, 0);
});

test('GitHub requests use Worker-supported manual redirects and reject redirects before allocation', async t => {
  const f = await fixture(t);
  t.mock.method(console, 'error', () => {});
  const delegate = globalThis.fetch;
  let redirect = false;
  let githubRequests = 0;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.hostname !== 'api.github.com') return delegate(input, init);
    githubRequests++;
    assert.equal(init?.redirect, 'manual');
    return redirect ? new Response(null, { status: 301, headers: { Location: 'https://example.com/redirect' } }) : delegate(input, init);
  });
  assert.equal((await f.create()).phase, 'allocating');
  assert.equal(githubRequests, 3); // Repository, commit and tree use the same policy.
  redirect = true;
  const response = await handleRequest(api('/repo-launches', 'POST', defaultOptions, 'redirected-launch'), f.env);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'github_unavailable' });
  assert.equal(githubRequests, 4);
  assert.equal(f.accountCalls.length, 0);
  assert.equal((f.sqlite.prepare('SELECT COUNT(*) AS count FROM repo_launches').get() as any).count, 1);
});

for (const authenticated of [false, true]) test(`GitHub lookups ${authenticated ? 'authenticate with the dedicated token' : 'work without a configured token'}`, async t => {
  const f = await fixture(t);
  if (authenticated) f.env.REPO_RUN_GITHUB_TOKEN = 'repo-lookup-test-token';
  const delegate = globalThis.fetch;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.hostname !== 'api.github.com') return delegate(input, init);
    calls++;
    assert.equal(new Headers(init?.headers).get('Authorization'), authenticated ? `Bearer ${f.env.REPO_RUN_GITHUB_TOKEN}` : null);
    assert.equal(init?.redirect, 'manual');
    if (url.pathname.endsWith(`/git/trees/${tree}`)) return Response.json({ tree: [{ path: 'app', type: 'tree', sha: 'c'.repeat(40) }] });
    return delegate(input, init);
  });
  const resolved = await handleRequest(api('/repo-launches/resolve?repo=acme/demo&cwd=app'), f.env);
  assert.equal(resolved.status, 200);
  const options = { repo: 'acme/demo', cwd: 'app' };
  const state = await f.create(options);
  assert.equal(calls, 8); // Metadata, commit, root tree and nested directory for both routes.
  assert.ok(!JSON.stringify(state).includes('repo-lookup-test-token'));
  assert.ok(!(await resolved.text()).includes('repo-lookup-test-token'));
  assert.ok(!cloneCommand(state.repository).includes('repo-lookup-test-token'));
  assert.equal(f.accountCalls.length, 0);
});

test('the operator public-lookup token never authorizes private repositories', async t => {
  const f = await fixture(t);
  f.env.REPO_RUN_GITHUB_TOKEN = 'repo-lookup-test-token';
  f.githubMode('private');
  const response = await handleRequest(api('/repo-launches', 'POST', defaultOptions), f.env);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'github_connection_required' });
  assert.equal(f.githubCalls.length, 1);
  assert.equal(f.accountCalls.length, 0);
});

test('private launch uses only the owner’s Import credentials, uploads Git objects, and reconciles lost execution replies without another import', async t => {
  const f = await fixture(t);
  f.githubMode('private');
  const token = 'ghu_private-user-one';
  f.sqlite.prepare('INSERT INTO github_import_connections (user_id, github_user_id, github_login, credentials, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(USER_ONE, '1', 'github-one', await sealGithubCredentials(f.env, USER_ONE, { access_token: token }), Date.now() + 86400000);
  const delegate = globalThis.fetch;
  let packCalls = 0;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/git-upload-pack')) {
      packCalls++;
      assert.equal(new Headers(init?.headers).get('Authorization'), `Basic ${btoa(`x-access-token:${token}`)}`);
      const data = Buffer.concat([Buffer.from([1]), Buffer.from('PACK'), Buffer.alloc(40)]);
      const packet = Buffer.concat([Buffer.from((data.length + 4).toString(16).padStart(4, '0')), data, Buffer.from('0000')]);
      return new Response(packet, { headers: { 'content-type': 'application/x-git-upload-pack-result' } });
    }
    return delegate(input, init);
  });
  const state = await f.create();
  assert.equal(state.repository.private, true);
  const other = await handleRequest(api('/repo-launches/resolve?repo=acme/demo', 'GET', undefined, 'k', SESSION_TWO), f.env);
  assert.equal(other.status, 400); assert.deepEqual(await other.json(), { error: 'github_connection_required' });
  const allocated = await f.step(state);
  f.loseExecution();
  assert.equal((await handleRequest(api(`/repo-launches/${state.id}/advance`, 'POST'), f.env)).status, 503);
  const resumed = await f.step(allocated);
  assert.equal(packCalls, 1); assert.equal(f.uploadedFiles.size, 1); assert.equal(resumed.importParts, 1);
  const commandRequest = f.executionCalls.find(request => request.method === 'POST')!;
  const command = (await commandRequest.clone().json() as any).command;
  assert.match(command, /git index-pack --stdin/); assert.match(command, /git checkout -q --detach/);
  assert.doesNotMatch(JSON.stringify(resumed) + command, /ghu_|Authorization|x-access-token/);
  f.complete(resumed, 'cloning');
  assert.equal((await f.step(resumed)).phase, 'ready');
});

test('revoked private access prevents allocation even after a launch record was created', async t => {
  const f = await fixture(t); f.githubMode('private');
  f.sqlite.prepare('INSERT INTO github_import_connections (user_id, github_user_id, github_login, credentials, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(USER_ONE, '1', 'github-one', await sealGithubCredentials(f.env, USER_ONE, { access_token: 'ghu_private-user-one' }), Date.now() + 86400000);
  const state = await f.create();
  f.sqlite.prepare('DELETE FROM github_import_connections WHERE user_id = ?').run(USER_ONE);
  const denied = await handleRequest(api(`/repo-launches/${state.id}/advance`, 'POST'), f.env);
  assert.equal(denied.status, 400); assert.deepEqual(await denied.json(), { error: 'github_connection_required' });
  assert.equal(f.accountCalls.length, 0); assert.equal(f.uploadedFiles.size, 0);
});

test('invalid GitHub credentials fail without an unauthenticated retry and are redacted from logs', async t => {
  const f = await fixture(t);
  const token = f.env.REPO_RUN_GITHUB_TOKEN = 'repo-lookup-test-token';
  const logs: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(args); });
  const delegate = globalThis.fetch;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.hostname !== 'api.github.com') return delegate(input, init);
    calls++;
    return Response.json({ message: `Bad credentials ${token}` }, { status: 401 });
  });
  const response = await handleRequest(api('/repo-launches', 'POST', defaultOptions), f.env);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'github_unavailable' });
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(logs).includes(token));
  assert.match(JSON.stringify(logs), /Bad credentials \[redacted\]/);
  assert.equal(f.accountCalls.length, 0);
});

test('transport failure retains nested causes while redacting credentials and submitted commands', async t => {
  const f = await fixture(t);
  const logs: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(args); });
  const command = 'echo private-command-content';
  const delegate = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.hostname !== 'api.github.com') return delegate(input);
    throw new Error(`connection failed ${SESSION_ONE} ${command}`, { cause: new Error(`socket closed ${f.env.STRIPE_SECRET_KEY}`) });
  });
  const response = await handleRequest(api('/repo-launches', 'POST', { ...defaultOptions, setupCommand: command }), f.env);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'github_unavailable' });
  const details = logs.find(([event]) => event === 'repo_launch_request_failed')![1] as any;
  assert.equal(details.stage, 'resolve_repository');
  assert.match(details.error.cause.message, /connection failed \[redacted\] \[redacted\]/);
  assert.match(details.error.cause.cause.message, /socket closed \[redacted\]/);
  for (const secret of [SESSION_ONE, command, f.env.STRIPE_SECRET_KEY]) assert.ok(!JSON.stringify(logs).includes(secret));
});

test('advance failure logs its launch identity and original stage after releasing the lease', async t => {
  const f = await fixture(t); const state = await f.create();
  const logs: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(args); });
  f.loseAllocation();
  const response = await handleRequest(api(`/repo-launches/${state.id}/advance`, 'POST'), f.env);
  assert.equal(response.status, 503);
  const details = logs.find(([event]) => event === 'repo_launch_request_failed')![1] as any;
  assert.equal(details.stage, 'allocate_container');
  assert.equal(details.launchId, state.id); assert.equal(details.phase, 'allocating');
  assert.equal((f.sqlite.prepare('SELECT lock_until FROM repo_launches WHERE id = ?').get(state.id) as any).lock_until, 0);
});

test('read-only resolution and launch creation never allocate; commits resolve before quota is consumed', async t => {
  const f = await fixture(t);
  const response = await handleRequest(api('/repo-launches/resolve?repo=acme/demo&ref=feature%2Fa'), f.env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { repo: 'acme/demo', ref: 'feature/a', commit, suggestedCatalogId: 'node', manifests: ['package.json'] });
  const launch = await f.create();
  assert.equal(launch.options.size, 'small'); assert.equal(launch.repository.commit, commit);
  assert.equal(f.accountCalls.length, 0); assert.equal(f.machineCalls.length, 0);
  assert.equal((await handleRequest(api(`/repo-launches/${launch.id}`), f.env)).status, 200);
  assert.equal(f.accountCalls.length, 0);
  assert.ok(f.githubCalls.some(url => url.includes('feature%2Fa')));
});

test('signed-in paid and coupon trial owners are required; bad inputs, origins and public repo checks precede allocation', async t => {
  const f = await fixture(t);
  assert.equal((await handleRequest(api('/repo-launches', 'POST', defaultOptions, 'k', 'missing'), f.env)).status, 401);
  assert.equal((await handleRequest(api('/repo-launches', 'POST', defaultOptions, 'k', SESSION_ONE, 'https://evil.test'), f.env)).status, 403);
  assert.equal((await handleRequest(api('/repo-launches', 'POST', defaultOptions, 'k', SESSION_ONE, null), f.env)).status, 403);
  for (const options of [{ repo: 'https://evil.test/x' }, { repo: 'acme/demo', cwd: '../root' }, { repo: 'acme/demo', ref: 'a\n; id' },
    { repo: 'acme/demo', startCommand: 'npm start' }, { repo: 'acme/demo', startCommand: 'npm start', port: 22 }, { repo: 'acme/demo', catalogId: 'unknown' }]) {
    assert.equal((await handleRequest(api('/repo-launches', 'POST', options), f.env)).status, 400);
  }
  for (const mode of ['private', 'missing', 'limited']) {
    f.githubMode(mode);
    assert.equal((await handleRequest(api('/repo-launches', 'POST', defaultOptions), f.env)).status, mode === 'limited' ? 429 : 400);
  }
  f.githubMode('public'); f.setBillingMode('unpaid');
  assert.equal((await handleRequest(api('/repo-launches', 'POST', defaultOptions), f.env)).status, 402);
  f.sqlite.prepare('DELETE FROM pro_billing WHERE user_id = ?').run(USER_ONE);
  f.sqlite.prepare('INSERT INTO trial_coupons VALUES (?, ?, ?, ?, ?, ?, ?)').run('coupon', 'builder', 7, Date.now() + 86400000, 10, 0, 1);
  f.sqlite.prepare('INSERT INTO trial_redemptions VALUES (?, ?, ?, ?, ?)').run(USER_ONE, 'coupon', 'builder', Date.now(), Date.now() + 86400000);
  assert.equal((await f.create()).phase, 'allocating');
  assert.equal(f.accountCalls.length, 0);
});

test('repeat launch requests and independent recipients keep private owner identity and unchanged options', async t => {
  const f = await fixture(t);
  const one = await f.create(); const lookups = f.githubCalls.length;
  const duplicate = await f.create(); assert.equal(duplicate.id, one.id); assert.equal(f.githubCalls.length, lookups);
  assert.equal((await handleRequest(api('/repo-launches', 'POST', { ...defaultOptions, ref: 'different' }), f.env)).status, 409);
  const two = await f.create(defaultOptions, 'launch-one', SESSION_TWO); assert.notEqual(two.id, one.id);
  for (const [path, method] of [[`/repo-launches/${one.id}`, 'GET'], [`/repo-launches/${one.id}/advance`, 'POST']])
    assert.equal((await handleRequest(api(path, method, undefined, 'k', SESSION_TWO), f.env)).status, 404);
});

test('terminal-only launch resumes through clone inspection and never reruns completed operations', async t => {
  const f = await fixture(t); let state = await f.create();
  state = await f.step(state); assert.equal(state.phase, 'cloning'); assert.ok(state.container);
  const allocation = f.accountCalls.find(call => call.request.method === 'POST')!.request;
  assert.deepEqual(await allocation.json(), { name: 'acme/demo', imageKey: 'terminal', imageName: 'Node 24 + TypeScript', size: 'small' });
  state = await f.step(state); assert.ok(state.executions.cloning); assert.equal(state.shellReadyAt, null);
  state = await f.step(state); assert.equal(state.phase, 'cloning');
  f.complete(state, 'cloning'); state = await f.step(state);
  assert.equal(state.phase, 'ready'); assert.ok(state.shellReadyAt); assert.equal(state.previewReadyAt, null);
  state = await f.step(state); assert.equal(state.phase, 'ready');
  assert.equal(f.creations.size, 1); assert.equal(f.executionKeys.size, 1);
  assert.equal((f.sqlite.prepare("SELECT COUNT(*) AS n FROM acquisition_events WHERE event_type='workspace.started'").get() as any).n, 1);
  assert.equal((f.sqlite.prepare("SELECT COUNT(*) AS n FROM acquisition_events WHERE event_type='workload.activated'").get() as any).n, 0);
});

test('lost allocation and execution responses reconcile stable keys without duplicated starts or commands', async t => {
  const f = await fixture(t); let state = await f.create();
  f.loseAllocation(); assert.equal((await handleRequest(api(`/repo-launches/${state.id}/advance`, 'POST'), f.env)).status, 503);
  state = await f.step(state); assert.equal(f.containers.get(USER_ONE)!.length, 1);
  f.loseExecution(); assert.equal((await handleRequest(api(`/repo-launches/${state.id}/advance`, 'POST'), f.env)).status, 503);
  state = await f.step(state); assert.ok(state.executions.cloning); assert.equal(f.executionKeys.size, 1);
  const calls = f.executionCalls.filter(call => call.method === 'POST');
  assert.equal(calls[0].headers.get('Idempotency-Key'), calls[1].headers.get('Idempotency-Key'));
  assert.deepEqual(await calls[0].json(), await calls[1].json());
});

test('preview workflow persists clone/install/start IDs, readiness and separate shell timing', async t => {
  const f = await fixture(t);
  let state = await f.create({ ...defaultOptions, setupCommand: 'npm ci', startCommand: 'npm start', port: 3000 } as typeof defaultOptions);
  state = await f.step(state); state = await f.step(state); f.complete(state, 'cloning'); state = await f.step(state);
  assert.equal(state.phase, 'setup'); assert.ok(state.shellReadyAt); assert.equal(state.previewReadyAt, null);
  state = await f.step(state); f.complete(state, 'setup'); state = await f.step(state); assert.equal(state.phase, 'starting');
  state = await f.step(state); f.complete(state, 'starting'); state = await f.step(state); assert.equal(state.phase, 'ready');
  assert.ok(state.previewReadyAt); assert.equal(f.executionKeys.size, 3);
  assert.equal((f.sqlite.prepare("SELECT COUNT(*) AS n FROM acquisition_events WHERE event_type='workspace.started'").get() as any).n, 1);
  assert.equal((f.sqlite.prepare("SELECT COUNT(*) AS n FROM acquisition_events WHERE event_type='workload.activated'").get() as any).n, 1);
  assert.equal(JSON.parse((f.sqlite.prepare("SELECT payload FROM acquisition_events WHERE event_type='workload.activated'").get() as any).payload).basis, 'http_preview_ready');
  const startRequest = f.executionCalls.filter(call => call.method === 'POST').at(-1)!;
  const startBody = await startRequest.json() as { command: string; timeoutMs: number };
  assert.match(startBody.command, /tmux new-session -d -s mainbrella-preview/); assert.match(startBody.command, /http:\/\/127\.0\.0\.1:3000/);
  assert.equal(startBody.timeoutMs, 240000);
});

test('setup failure preserves shell and retained logs and cannot silently rerun setup', async t => {
  const f = await fixture(t); let state = await f.create({ ...defaultOptions, setupCommand: 'exit 1' } as typeof defaultOptions);
  state = await f.step(state); state = await f.step(state); f.complete(state, 'cloning'); state = await f.step(state);
  state = await f.step(state); f.complete(state, 'setup', 'failed'); state = await f.step(state);
  assert.equal(state.phase, 'failed'); assert.equal(state.error, 'setup_failed'); assert.ok(state.shellReadyAt); assert.ok(state.container);
  state = await f.step(state); assert.equal(f.executionKeys.size, 2);
  assert.equal((f.sqlite.prepare("SELECT COUNT(*) AS n FROM acquisition_events WHERE event_type='launch.failed'").get() as any).n, 1);
  assert.equal((f.sqlite.prepare("SELECT COUNT(*) AS n FROM acquisition_events WHERE event_type='workload.activated'").get() as any).n, 0);
});

test('expired history and uncertain execution retention never trigger automatic replay', async t => {
  const f = await fixture(t); let state = await f.create(); state = await f.step(state);
  state.attempts.cloning = Date.now() - 3600000; f.mutate(state);
  state = await f.step(state); assert.equal(state.error, 'execution_reconciliation_required'); assert.equal(f.executionKeys.size, 0);
  let second = await f.create(defaultOptions, 'second'); second = await f.step(second); second = await f.step(second);
  f.executions.delete(second.executions.cloning!);
  second = await f.step(second); assert.equal(second.error, 'execution_history_expired'); assert.equal(f.executionKeys.size, 1);
});

test('container slot reuse and durable leases never target another generation', async t => {
  const f = await fixture(t); let state = await f.create();
  f.sqlite.prepare('UPDATE repo_launches SET lock_until = ? WHERE id = ?').run(Date.now() + 60000, state.id);
  assert.equal((await f.step(state)).phase, 'allocating'); assert.equal(f.accountCalls.length, 0);
  f.sqlite.prepare('UPDATE repo_launches SET lock_until = 0 WHERE id = ?').run(state.id);
  state = await f.step(state);
  f.containers.get(USER_ONE)![0].createdAt = '2090-01-01T00:00:00.000Z';
  state = await f.step(state); assert.equal(state.phase, 'stopped'); assert.equal(f.executionKeys.size, 0);
});

test('generated shell scripts pin commits, contain paths, and quote user commands', () => {
  const options = launchOptionsSchema.parse({ repo: 'acme/demo', cwd: 'apps/web', setupCommand: "echo 'ready'; printf '$HOME'", startCommand: 'npm start', port: 8080 });
  const clone = cloneCommand({ repo: 'acme/demo', ref: 'main', commit, suggestedCatalogId: 'node', manifests: [] });
  assert.match(clone, new RegExp(`fetch --depth=1 origin '${commit}'`));
  assert.match(clone, /tmux new-session -d -s main -c \/workspace\/repo/);
  assert.match(setupCommand(options), /pwd -P/);
  assert.match(setupCommand(options), /cd '\/workspace\/repo\/apps\/web'/);
  assert.match(previewCommand(options), /mainbrella-preview.log/);
});

test('runtime detection suggests a single manifest runtime and leaves ambiguous projects overridable', async t => {
  const f = await fixture(t);
  for (const [manifests, runtime] of [[['pyproject.toml'], 'python'], [['Cargo.toml'], 'rust'], [['go.mod'], 'go'], [['main.tf'], 'devops'], [['go.mod', 'package.json'], 'node']] as const) {
    f.manifests([...manifests]);
    const response = await handleRequest(api('/repo-launches/resolve?repo=acme/demo'), f.env);
    assert.equal((await response.json() as any).suggestedCatalogId, runtime);
  }
  f.manifests(['pyproject.toml']);
  const state = await f.create({ ...defaultOptions, catalogId: 'node' } as typeof defaultOptions);
  await f.step(state);
  assert.equal((await f.accountCalls.find(call => call.request.method === 'POST')!.request.json() as any).imageKey, 'terminal');
});
test('concurrent advances allocate once and launch inspection stays available after access expires', async t => {
  const f = await fixture(t); const state = await f.create();
  await Promise.all([f.step(state), f.step(state)]);
  assert.equal(f.containers.get(USER_ONE)!.length, 1); assert.equal(f.creations.size, 1);
  f.setBillingMode('unpaid');
  assert.equal((await handleRequest(api(`/repo-launches/${state.id}`), f.env)).status, 200);
  assert.equal((await handleRequest(api(`/repo-launches/${state.id}/advance`, 'POST'), f.env)).status, 402);
});
test('uncertain allocation is never repeated after its coordinator retention window', async t => {
  const f = await fixture(t); let state = await f.create();
  state.attempts.allocating = Date.now() - 86400000; f.mutate(state);
  state = await f.step(state); assert.equal(state.error, 'allocation_reconciliation_required');
  assert.equal(f.creations.size, 0); assert.equal(f.accountCalls.length, 0);
});

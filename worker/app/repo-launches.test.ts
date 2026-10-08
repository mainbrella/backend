import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleRequest } from './router';
import { paidContainerFixture, SESSION_ONE, SESSION_TWO, USER_ONE, USER_TWO } from './paid-container-test-helpers';
import { cloneCommand, launchOptionsSchema, previewCommand, setupCommand } from '../lib/repo-launch';
import type { RepoLaunch } from './repo-launches';
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
  f.sqlite.exec(readFileSync(new URL('../../migrations/013_repo_launches.sql', import.meta.url), 'utf8'));
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
  let loseExecution = false;
  f.env.USER_CONTAINER = {
    idFromName(name: string) { f.machineNames.push(name); return name; },
    get(name: string) { return { async fetch(request: Request) {
      f.machineCalls.push({ name, request }); executionCalls.push(request);
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
  return { ...f, create, step, complete, mutate, githubCalls, executions, executionKeys, executionCalls, creations,
    githubMode(value: string) { githubMode = value; }, manifests(value: string[]) { manifests = value; }, loseAllocation() { loseAllocation = true; }, loseExecution() { loseExecution = true; } };
}

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

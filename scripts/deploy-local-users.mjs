import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fetchLocalPreview } from './local-preview.mjs';

// Run with node --env-file=.env scripts/deploy-local-users.mjs.
// Build the Go example for linux/amd64 into .wrangler/private-services-api-amd64 first.
// State includes a bearer preview URL; keep it private. Ordinary stop loses SQLite data.
const base = 'http://localhost:8787';
const key = process.env.MAINBRELLA_LOCAL_API_KEY;
assert.match(key ?? '', /^mb_[A-Za-z0-9_-]+$/, 'Provision MAINBRELLA_LOCAL_API_KEY in the local environment.');
const statePath = resolve('.wrangler/local-users-deployment.json');
const cleanupOnly = process.argv.includes('--cleanup');
if (!cleanupOnly && existsSync(statePath) && JSON.parse(readFileSync(statePath, 'utf8')).cleanup === 'completed') {
  renameSync(statePath, `${statePath}.${Date.now()}.completed`);
}
assert.ok(cleanupOnly || !existsSync(statePath), 'Saved deployment exists; inspect it and use --cleanup before a new launch.');
assert.ok(!cleanupOnly || existsSync(statePath), 'No saved deployment to clean up.');
const state = cleanupOnly ? JSON.parse(readFileSync(statePath, 'utf8')) : {
  network: `users-${randomUUID().slice(0, 8)}`, containers: [], checks: {},
};
mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
const wait = () => new Promise(resolve => setTimeout(resolve, 1000));
async function request(path, method = 'GET', body, extraHeaders = {}) {
  const binary = body instanceof Uint8Array;
  const response = await fetch(new URL(path, base), {
    method, headers: { Authorization: `Bearer ${key}`, ...extraHeaders,
      ...(body === undefined ? {} : { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' }) },
    body: body === undefined ? undefined : binary ? body : JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(`HTTP ${response.status}: ${data.error ?? 'request_failed'}`);
  }
  return response.json();
}
const query = machine => new URLSearchParams({ id: machine.id, createdAt: machine.createdAt });
async function command(machine, command) {
  const result = await request(`/containers/exec?${query(machine)}`, 'POST', { command, timeoutMs: 30_000 });
  assert.equal(result.exitCode, 0, 'Guest command failed; inspect its log via generation-qualified execution.');
  assert.equal(result.timedOut, false);
  assert.equal(result.outputTruncated, false);
  return result.stdout;
}
async function create(role) {
  const machine = { role, creationKey: randomUUID(), body: { catalogId: 'node', size: 'lite' } };
  state.containers.push(machine); save();
  // Reconcile an ambiguous creation using exactly the saved body and key.
  let result;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { result = await request('/containers', 'POST', machine.body, { 'Idempotency-Key': machine.creationKey }); }
    catch (error) { if (!/fetch|timeout|HTTP 503/i.test(error.message)) throw error; }
    if (result?.creation?.status === 'running') break;
    await wait();
  }
  const creation = result?.creation;
  if (creation?.containerId && creation?.createdAt) {
    Object.assign(machine, { id: creation.containerId, createdAt: creation.createdAt }); save();
  }
  assert.equal(creation?.status, 'running', 'Creation unresolved; reconcile the saved creationKey before launching again.');
  const running = result.containers.find(item => item.id === machine.id && item.createdAt === machine.createdAt);
  assert.equal(running?.size, 'lite');
  machine.expiresAt = running.expiresAt;
  save(); return machine;
}
async function write(machine, path, bytes) {
  return request(`/containers/files?${query(machine)}&${new URLSearchParams({ path })}`, 'PUT', bytes);
}
async function attach(machine, name, port) {
  await request(`/private-services/members?network=${state.network}`, 'PUT',
    { id: machine.id, createdAt: machine.createdAt, name, ...(port ? { port } : {}) });
}
async function cleanup() {
  const failures = [];
  for (const machine of [...state.containers].reverse()) {
    if (!machine.id) { failures.push('Unresolved creation: reconcile saved creationKey.'); continue; }
    try {
      const after = await request(`/containers?${query(machine)}`, 'DELETE');
      assert.ok(!after.containers.some(item => item.id === machine.id && item.createdAt === machine.createdAt));
      machine.cleanup = 'completed'; save();
    } catch (error) { failures.push(error.message); }
  }
  if (state.networkCreated) {
    try { await request(`/private-services/networks?network=${state.network}`, 'DELETE'); state.networkCreated = false; }
    catch (error) { failures.push(error.message); }
  }
  state.cleanup = failures.length ? failures : 'completed'; save();
  assert.equal(failures.length, 0, 'Cleanup unresolved; inspect the private saved state.');
}
if (cleanupOnly) {
  await cleanup();
  console.log(JSON.stringify({ cleanup: state.cleanup, statePath }));
} else {
  const binary = readFileSync('.wrangler/private-services-api-amd64');
  const frontendSource = readFileSync(new URL('../examples/private-services/frontend.mjs', import.meta.url));
  try {
    const capabilities = await request('/capabilities'), before = await request('/containers');
    assert.equal(capabilities.networking.privateServices, true);
    assert.equal(capabilities.previews.supported, true);
    assert.ok(capabilities.execution.foreground && capabilities.files.binary && capabilities.files.write);
    assert.ok(before.active && before.imageCatalog.some(image => image.id === 'node'));
    assert.ok(before.containers.length + 2 <= before.limits.maxContainers);
    assert.ok(before.usage.starts + 2 <= before.limits.maxStartsPerMonth);
    assert.ok(before.usage.availableComputeUnitHours > 0);
    assert.ok(before.usage.concurrentComputeUnits + 2 <= before.limits.maxConcurrentComputeUnits);
    state.existingContainers = before.containers.map(({ id, createdAt }) => ({ id, createdAt })); save();
    await request('/private-services/networks', 'POST', { name: state.network });
    state.networkCreated = true; save();
    const backend = await create('backend'), frontend = await create('frontend');
    const parts = [];
    for (let offset = 0; offset < binary.length; offset += 1024 * 1024) {
      const path = `/workspace/api-part-${parts.length}`;
      await write(backend, path, binary.subarray(offset, offset + 1024 * 1024)); parts.push(path);
    }
    const digest = createHash('sha256').update(binary).digest('hex');
    await command(backend, `cat ${parts.join(' ')} > /workspace/api && echo '${digest}  /workspace/api' | sha256sum -c - && chmod 755 /workspace/api && rm ${parts.join(' ')}`);
    await write(frontend, '/workspace/frontend.mjs', frontendSource);
    await command(backend, 'setsid nohup /workspace/api > /workspace/api.log 2>&1 < /dev/null &');
    await command(frontend, 'setsid nohup node /workspace/frontend.mjs > /workspace/frontend.log 2>&1 < /dev/null &');
    await attach(backend, 'api', 8080); await attach(frontend, 'web');
    await command(backend, 'for i in $(seq 1 20); do curl -fsS http://127.0.0.1:8080/users && exit 0; sleep 1; done; exit 1');
    const payload = JSON.parse(await command(frontend, 'curl -fsS http://api.internal/users'));
    assert.deepEqual(payload.users.map(user => user.name), ['Ada Lovelace', 'Grace Hopper', 'Linus Torvalds']);
    state.checks.privateSqliteThreeUsers = true;
    const html = await command(frontend, 'curl -fsS http://127.0.0.1:3000/');
    assert.equal((html.match(/<tr><td>/g) ?? []).length, 3);
    for (const user of payload.users) assert.ok(html.includes(user.name) && html.includes(user.email));
    state.checks.frontendThreeRenderedRows = true;
    state.previewPending = true; save();
    state.preview = await request(`/containers/previews?${query(frontend)}`, 'POST', { port: 3000, ttlSeconds: 900 });
    state.previewPending = false; save();
    const previewHtml = await fetchLocalPreview(state.preview.url, '/');
    assert.equal(previewHtml.status, 200);
    assert.equal((await previewHtml.text()).match(/<tr><td>/g)?.length, 3);
    const api = await fetchLocalPreview(state.preview.url, '/api/users');
    assert.equal(api.status, 200); assert.deepEqual(await api.json(), payload);
    state.checks.previewHtmlAndApi = true; state.ok = true; save();
    console.log(JSON.stringify({ ok: true, checks: state.checks, containers: state.containers.map(({ role, id, createdAt }) => ({ role, id, createdAt })), previewExpiresAt: state.preview.expiresAt, statePath }, null, 2));
  } catch (error) {
    state.error = error.message; save();
    try { await cleanup(); } catch { console.error('Cleanup needs reconciliation; inspect private state.'); }
    throw error;
  }
}

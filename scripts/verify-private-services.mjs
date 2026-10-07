import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Mainbrella } from '../sdk/javascript/index.js';
import { fetchLocalPreview } from './local-preview.mjs';

// Local platform prototype: three starts total, never more than two Lite guests
// at once. The third start proves replacement fencing on the backend slot.
const credentialsPath = process.argv.find(value => value.startsWith('--credentials='))?.slice(14)
  ?? '.wrangler/private-services-local-credentials.json';
const output = resolve(process.argv.find(value => value.startsWith('--output='))?.slice(9) ?? '.wrangler/private-services-verification');
const credentials = JSON.parse(readFileSync(credentialsPath, 'utf8'));
assert.ok(['localhost', '127.0.0.1'].includes(new URL(credentials.baseUrl).hostname), 'This bounded prototype runner accepts local deployments only.');
const client = new Mainbrella({ ...credentials, timeoutMs: 90_000 });
const binary = readFileSync('.wrangler/private-services-api-amd64');
const frontendSource = readFileSync(new URL('../examples/private-services/frontend.mjs', import.meta.url));
const network = `demo-${randomUUID().slice(0, 8)}`, otherNetwork = `${network}-other`;
const report = { startedAt: new Date().toISOString(), network, otherNetwork, machines: [], checks: {}, cleanup: {}, ok: false };
mkdirSync(output, { recursive: true, mode: 0o700 });
const checkpoint = () => writeFileSync(`${output}/report.json`, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
const active = [], registered = [];
const create = async role => {
  const attempt = { role, idempotencyKey: randomUUID() };
  report.machines.push(attempt); checkpoint();
  const machine = await client.create({ size: 'lite', catalogId: 'node', idempotencyKey: attempt.idempotencyKey });
  Object.assign(attempt, { id: machine.id, createdAt: machine.createdAt, instance: machine.instance });
  active.push(machine); checkpoint();
  return machine;
};
const exec = async (machine, command) => {
  const result = await machine.commands.run(command, { timeoutMs: 20_000 });
  assert.equal(result.timedOut, false, 'Command timed out');
  assert.equal(result.outputTruncated, false, 'Command output was truncated');
  assert.equal(result.exitCode, 0, `Command failed: ${result.stderr}`);
  return result.stdout;
};
const attach = async (machine, name, port, selected = network) => {
  const body = { id: machine.id, createdAt: machine.createdAt, name, ...(port ? { port } : {}) };
  await client.request(`/private-services/members?network=${selected}`, { method: 'PUT', body });
  registered.push({ network: selected, ...body });
};
const detach = (machine, name, selected = network) => client.request(`/private-services/members?network=${selected}`, {
  method: 'DELETE', body: { id: machine.id, createdAt: machine.createdAt, name } });
const requestPrivate = async machine => JSON.parse(await exec(machine,
  "curl --silent --show-error --max-time 15 -w '\\n%{http_code}' http://api.internal/users | node -e 'let s=\"\";process.stdin.on(\"data\",c=>s+=c);process.stdin.on(\"end\",()=>{const i=s.lastIndexOf(\"\\n\");console.log(JSON.stringify({status:Number(s.slice(i+1)),body:s.slice(0,i)}))})'"));

try {
  assert.equal((await client.list()).containers.length, 0, 'Use an isolated account with no existing machines.');
  assert.equal((await client.capabilities()).networking.privateServices, true);
  for (const name of [network, otherNetwork]) await client.request('/private-services/networks', { method: 'POST', body: { name } });
  const backend = await create('backend'), frontend = await create('frontend');
  console.log('Two Lite machines running; uploading the Go backend and frontend.');
  const partPaths = [];
  for (let offset = 0; offset < binary.length; offset += 1024 * 1024) {
    const path = `/workspace/api-part-${String(partPaths.length).padStart(3, '0')}`;
    await backend.files.write(path, binary.subarray(offset, offset + 1024 * 1024));
    partPaths.push(path);
  }
  await exec(backend, `cat ${partPaths.join(' ')} > /workspace/api && chmod 755 /workspace/api && rm ${partPaths.join(' ')}`);
  await backend.commands.start(['/workspace/api'], { timeoutMs: 600_000 });
  await frontend.files.write('/workspace/frontend.mjs', frontendSource);
  await frontend.commands.start(['node', '/workspace/frontend.mjs'], { timeoutMs: 600_000 });
  await attach(backend, 'api', 8080);
  await attach(frontend, 'web');
  const users = JSON.parse(await exec(backend, 'curl --fail --silent --show-error http://127.0.0.1:8080/users'));
  assert.equal(users.users.length, 3);
  report.checks.backendSqliteThreeUsers = true;
  const privateResponse = await requestPrivate(frontend);
  assert.equal(privateResponse.status, 200, privateResponse.body);
  assert.deepEqual(JSON.parse(privateResponse.body), users);
  report.checks.privateHttpThreeUsers = true; checkpoint();
  assert.deepEqual((await backend.previews.list()).previews, []);
  report.checks.backendHasNoPreview = true;
  const preview = await frontend.previews.create(3000, { ttlSeconds: 120 });
  // The helper preserves the preview URL authority and resolves only to loopback.
  // Never put the bearer preview URL into evidence or logs.
  const previewFetch = path => fetchLocalPreview(preview.url, path);
  const html = await previewFetch('/');
  assert.equal(html.status, 200);
  assert.match(await html.text(), /<h1>Users<\/h1>/);
  const browserUsers = await previewFetch('/api/users');
  assert.equal(browserUsers.status, 200);
  assert.deepEqual(await browserUsers.json(), users);
  report.checks.frontendPreviewThreeUsers = true;
  await frontend.previews.revoke(preview.id);
  await detach(frontend, 'web');
  await attach(frontend, 'web', undefined, otherNetwork);
  assert.equal((await requestPrivate(frontend)).status, 403);
  report.checks.otherNetworkDenied = true;
  await detach(frontend, 'web', otherNetwork);
  await attach(frontend, 'web');
  await backend.kill();
  assert.equal((await requestPrivate(frontend)).status, 403);
  report.checks.stoppedDestinationDenied = true;
  const replacement = await create('replacement-backend');
  assert.equal(replacement.id, backend.id, 'Replacement must reuse the stopped slot.');
  assert.notEqual(replacement.createdAt, backend.createdAt);
  assert.equal((await requestPrivate(frontend)).status, 403);
  report.checks.replacedDestinationDenied = true;
  await assert.rejects(client.request(`/private-services/members?network=${network}`, {
    method: 'PUT', body: { id: backend.id, createdAt: backend.createdAt, name: 'api', port: 8080 } }), { code: 'container_not_running', status: 409 });
  report.checks.staleRegistrationDenied = true;
  await attach(replacement, 'api', 8080);
  await detach(backend, 'api');
  const registry = await client.request('/private-services/networks');
  assert.ok(registry.networks.find(value => value.name === network).members.some(value => value.id === replacement.id && value.createdAt === replacement.createdAt));
  report.checks.staleDetachPreservesReplacement = true;
  report.ok = true;
} catch (error) {
  report.error = { code: error.code ?? error.name, message: error.message };
  process.exitCode = 1;
} finally {
  for (const machine of active.toReversed()) {
    try { await machine.kill(); report.cleanup[`${machine.id}/${machine.createdAt}`] = true; }
    catch (error) { report.cleanup[`${machine.id}/${machine.createdAt}`] = error.code ?? 'cleanup_failed'; report.ok = false; process.exitCode = 1; }
  }
  for (const { network: selected, ...body } of registered) {
    try { await client.request(`/private-services/members?network=${selected}`, { method: 'DELETE', body }); }
    catch { report.ok = false; process.exitCode = 1; }
  }
  for (const name of [network, otherNetwork]) {
    try { await client.request(`/private-services/networks?network=${name}`, { method: 'DELETE' }); }
    catch { report.ok = false; process.exitCode = 1; }
  }
  report.finishedAt = new Date().toISOString();
  checkpoint();
  console.log(JSON.stringify({ ok: report.ok, checks: report.checks, cleanup: report.cleanup, error: report.error, report: `${output}/report.json` }, null, 2));
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { Mainbrella } from './index.js';

const apiKey = `mb_${'a'.repeat(64)}`, createdAt = '2026-10-11T00:00:00.000Z';
const resumedAt = '2026-10-11T00:01:00.000Z';
const secretId = 'sec_d688d42a-25ef-4c13-9b28-21a0fde6e163';
test('stop preserves identity, resume replaces generation, and uncertain fork retries retain one key', async () => {
  const calls = []; let forkAttempts = 0;
  const client = new Mainbrella({ apiKey, fetch: async (url, options) => {
    if (url.pathname === '/capabilities') return Response.json({ persistence: { filesystemAfterStop: true, filesystemFork: true } });
    const body = options.body && JSON.parse(options.body); calls.push({ path: url.pathname, body, key: options.headers['Idempotency-Key'] });
    if (url.pathname === '/containers/stop') return Response.json({ containers: [{ ...body, status: 'stopped', workspaceId: 'saved' }] });
    if (url.pathname === '/containers' && options.method === 'DELETE') return Response.json({ containers: [] });
    if (url.pathname === '/containers/fork' && ++forkAttempts === 1) throw new Error('lost response');
    const id = url.pathname.endsWith('/fork') ? 'c1' : 'small';
    return Response.json({ creation: { id: 'receipt', containerId: id, createdAt: resumedAt, status: 'running' }, containers: [{ id, createdAt: resumedAt, status: 'running' }] });
  } });
  const source = client.connect({ id: 'small', createdAt });
  await source.stop({ idempotencyKey: 'stop-1' });
  const resumed = await source.resume({ idempotencyKey: 'resume-1' });
  assert.equal(resumed.id, source.id); assert.equal(resumed.createdAt, resumedAt); assert.equal(source.createdAt, createdAt);
  const fork = await resumed.fork({ name: 'Experiment', idempotencyKey: 'fork-1', pollIntervalMs: 1 });
  assert.equal(fork.id, 'c1'); assert.equal(forkAttempts, 2);
  const attempts = calls.filter(c => c.path.endsWith('/fork'));
  assert.deepEqual(attempts[0], attempts[1]); assert.deepEqual(attempts[0].body, { id: 'small', createdAt: resumedAt, name: 'Experiment' });
  await fork.delete(); assert.equal(calls.at(-1).path, '/containers');
});
test('SDK fails closed on unavailable lifecycle or an unconfirmed restricted launch', async () => {
  let starts = 0;
  const client = new Mainbrella({ apiKey, fetch: async url => {
    if (url.pathname === '/capabilities') return Response.json({ persistence: {}, networking: { egressPolicies: true }, secrets: { vault: true } });
    starts++; return Response.json({ creation: { id: 'receipt', containerId: 'small', createdAt, status: 'running' }, containers: [{ id: 'small', createdAt, status: 'running', internet: true }] });
  } });
  await assert.rejects(client.connect({ id: 'small', createdAt }).stop({ idempotencyKey: 'safe-stop' }), { code: 'persistence_unavailable', idempotencyKey: 'safe-stop' });
  assert.equal(starts, 0);
  await assert.rejects(client.create({ networkPolicy: { allow: ['api.example.com'] }, secretBindings: [secretId], idempotencyKey: 'restricted' }), { code: 'network_policy_unconfirmed', idempotencyKey: 'restricted' });
  assert.equal(starts, 1);
});
test('secret helpers send write-only values only for create and rotate and validate IDs locally', async () => {
  const calls = [];
  const client = new Mainbrella({ apiKey, fetch: async (url, options) => {
    calls.push({ path: url.pathname, method: options.method, body: options.body && JSON.parse(options.body) });
    return Response.json(options.method === 'DELETE' ? { deleted: true } : options.method === 'GET' ? { secrets: [] } : { id: secretId });
  } });
  await client.secrets.create({ name: 'API', value: 'private', hostname: 'api.example.com', header: 'authorization', prefix: 'Bearer ' });
  await client.secrets.rotate(secretId, 'replacement'); await client.secrets.list(); await client.secrets.delete(secretId);
  assert.deepEqual(calls[1].body, { value: 'replacement' }); assert.equal(calls[2].body, undefined); assert.equal(calls[3].body, undefined);
  assert.throws(() => client.secrets.delete('../containers'), { code: 'invalid_secret_identity' }); assert.equal(calls.length, 4);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { Mainbrella, MainbrellaError } from './index.js';

const apiKey = `mb_${'a'.repeat(64)}`;
const createdAt = '2026-10-05T12:00:00.000Z';

test('creation retries one key and selects returned identity among concurrent machines', async () => {
  const calls = [];
  const client = new Mainbrella({ apiKey, fetch: async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) throw new Error('lost response');
    return Response.json({ creation: { id: 'operation', containerId: 'c1', createdAt, status: calls.length === 2 ? 'starting' : 'running' },
      containers: [{ id: 'small', createdAt, status: 'running' }, { id: 'c1', createdAt, status: 'running' }] });
  } });
  const sandbox = await client.create({ catalogId: 'python', idempotencyKey: 'stable', pollIntervalMs: 1 });
  assert.equal(sandbox.id, 'c1');
  assert.equal(sandbox.creationId, 'operation');
  for (const { options } of calls) {
    assert.equal(options.headers['Idempotency-Key'], 'stable');
    assert.equal(options.headers.Authorization, `Bearer ${apiKey}`);
    assert.equal(options.redirect, 'error');
    assert.equal(options.body, '{"catalogId":"python"}');
  }
  assert.ok(!JSON.stringify(client).includes(apiKey));
});

test('commands are not retried and API failures expose only sanitized diagnostics', async () => {
  let calls = 0;
  const client = new Mainbrella({ apiKey, fetch: async () => { calls++; throw new Error(apiKey); } });
  await assert.rejects(client.connect({ id: 'small', createdAt }).commands.run('side effect'), { code: 'transport_unavailable' });
  assert.equal(calls, 1);
  const denied = new Mainbrella({ apiKey, fetch: async () => Response.json({ error: `secret: ${apiKey}` }, { status: 503 }) });
  await assert.rejects(denied.list(), { code: 'request_failed', status: 503 });
  await assert.rejects(new Mainbrella({ apiKey, fetch: async () => Response.json({ error: 'container_limit_exceeded' }, { status: 409 }) })
    .create({ idempotencyKey: 'keep-me' }), { code: 'container_limit_exceeded', idempotencyKey: 'keep-me' });
});

test('binary transfer and cleanup always retain generation and path escaping', async () => {
  const bytes = new Uint8Array([0, 128, 255]);
  const client = new Mainbrella({ apiKey, fetch: async (url, options) => {
    assert.equal(url.searchParams.get('id'), 'small');
    assert.equal(url.searchParams.get('createdAt'), createdAt);
    if (options.method === 'DELETE') return Response.json({ containers: [{ id: 'small', createdAt: '2099-01-01T00:00:00.000Z' }] });
    assert.equal(url.searchParams.get('path'), '/tmp/界 &?.bin');
    if (options.method === 'PUT') { assert.deepEqual(options.body, bytes); return Response.json({ size: 3 }); }
    return new Response(bytes);
  } });
  const sandbox = client.connect({ id: 'small', createdAt });
  await sandbox.files.write('/tmp/界 &?.bin', bytes);
  assert.deepEqual(await sandbox.files.read('/tmp/界 &?.bin'), bytes);
  await sandbox.kill();
  assert.throws(() => sandbox.files.write('/file', 'text'), MainbrellaError);
});

test('unsafe origins, paths and ambiguous creation are bounded', async () => {
  for (const baseUrl of ['http://example.com', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com/?key=secret']) {
    assert.throws(() => new Mainbrella({ apiKey, baseUrl }), { code: 'invalid_api_url' });
  }
  const client = new Mainbrella({ apiKey, baseUrl: 'http://localhost:8787', fetch: async () => { throw new Error(); } });
  await assert.rejects(client.request('//evil.example/file'), { code: 'invalid_api_path' });
  await assert.rejects(client.create({ idempotencyKey: 'recover-me', waitTimeoutMs: 10, pollIntervalMs: 1 }),
    { code: 'creation_ambiguous', idempotencyKey: 'recover-me' });
});

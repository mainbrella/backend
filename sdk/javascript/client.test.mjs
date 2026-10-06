import test from 'node:test';
import assert from 'node:assert/strict';
import { Mainbrella, MainbrellaError, Execution } from './index.js';

const apiKey = `mb_${'a'.repeat(64)}`;
const createdAt = '2026-10-05T12:00:00.000Z';

test('previews preserve generation, return one-time URLs and revoke metadata-only grants', async () => {
  const grant = { id: 'b'.repeat(32), port: 3000, createdAt, expiresAt: Date.now() + 900_000 };
  const calls = [];
  const client = new Mainbrella({ apiKey, fetch: async (url, options) => {
    calls.push(options);
    assert.equal(url.pathname, '/containers/previews');
    assert.equal(url.searchParams.get('id'), 'c1');
    assert.equal(url.searchParams.get('createdAt'), createdAt);
    if (options.method === 'POST') {
      assert.deepEqual(JSON.parse(options.body), { port: 3000, ttlSeconds: 600 });
      return Response.json({ ...grant, url: `https://${'a'.repeat(48)}.preview.example/` }, { status: 201 });
    }
    if (options.method === 'DELETE') {
      assert.equal(url.searchParams.get('previewId'), grant.id);
      return Response.json({ revoked: true });
    }
    return Response.json({ previews: [grant] });
  } });
  const sandbox = client.connect({ id: 'c1', createdAt });
  const link = await sandbox.previews.create(3000, { ttlSeconds: 600 });
  assert.equal(link.id, grant.id);
  assert.match(link.url, /^https:/);
  assert.deepEqual(await sandbox.previews.list(), { previews: [grant] });
  assert.deepEqual(await sandbox.previews.revoke(link.id), { revoked: true });
  for (const port of [22, 1023, 65536, 3000.5, '3000']) assert.throws(() => sandbox.previews.create(port), { code: 'invalid_preview_options' });
  for (const ttlSeconds of [59, 3601, 60.5, '600']) assert.throws(() => sandbox.previews.create(3000, { ttlSeconds }), { code: 'invalid_preview_options' });
  assert.throws(() => sandbox.previews.revoke('not-an-id'), { code: 'invalid_preview_identity' });
  assert.equal(calls.length, 3);
});

test('preview failures are never retried and expose only a valid reconciliation ID', async () => {
  let calls = 0;
  const id = 'b'.repeat(32);
  const client = new Mainbrella({ apiKey, fetch: async () => {
    calls++;
    return Response.json({ error: 'preview_reconciliation_required', previewId: id, token: apiKey }, { status: 503 });
  } });
  await assert.rejects(client.connect({ id: 'small', createdAt }).previews.create(3000),
    { code: 'preview_reconciliation_required', status: 503, previewId: id });
  assert.equal(calls, 1);
  for (const [error, previewId] of [['previews_unavailable', id], ['preview_reconciliation_required', apiKey]]) {
    const bad = new Mainbrella({ apiKey, fetch: async () => Response.json({ error, previewId }, { status: 503 }) });
    await assert.rejects(bad.connect({ id: 'small', createdAt }).previews.list(), cause => cause.previewId === undefined && !JSON.stringify(cause).includes(apiKey));
  }
});

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

test('managed streaming decodes fragmented Unicode, rotates with cursor and preserves explicit cancellation', async () => {
  const id = crypto.randomUUID();
  let streams = 0, canceled = false;
  const client = new Mainbrella({ apiKey, fetch: async (url, options) => {
    assert.equal(url.searchParams.get('createdAt'), createdAt);
    if (options.method === 'POST') { assert.equal(options.headers['Idempotency-Key'], 'managed-key'); return Response.json({ id }); }
    if (options.method === 'DELETE') { canceled = true; return Response.json({ id, status: 'canceled' }); }
    assert.equal(url.searchParams.get('cursor'), String(streams));
    const text = streams++ === 0
      ? 'id: 1\nevent: stdout\ndata: {"sequence":1,"type":"stdout","data":"héllo 界"}\n\nevent: status\ndata: {"status":"running"}\n\n'
      : 'id: 1\nevent: stdout\ndata: {"sequence":1,"type":"stdout","data":"duplicate"}\n\nid: 2\nevent: stderr\ndata: {"sequence":2,"type":"stderr","data":"problem"}\n\nevent: status\ndata: {"status":"succeeded"}\n\n';
    const bytes = new TextEncoder().encode(text);
    return new Response(new ReadableStream({ start(controller) { for (let n = 0; n < bytes.length; n += 7) controller.enqueue(bytes.slice(n, n + 7)); controller.close(); } }));
  } });
  const execution = await client.connect({ id: 'small', createdAt }).commands.start('echo hi', { idempotencyKey: 'managed-key' });
  const events = [];
  for await (const event of execution.events()) events.push(event);
  assert.deepEqual(events.filter(e => e.type !== 'status').map(e => e.data), ['héllo 界', 'problem']);
  assert.equal(execution.cursor, 2); assert.equal(streams, 2);
  await execution.cancel(); assert.equal(canceled, true);
});

test('streaming accepts many bounded events in one transport chunk and rejects incomplete frames', async () => {
  const id = crypto.randomUUID();
  const frames = Array.from({ length: 200 }, (_, n) => `id: ${n + 1}\nevent: stdout\ndata: ${JSON.stringify({ type: 'stdout', sequence: n + 1, data: 'x'.repeat(1000) })}\n\n`).join('');
  const client = new Mainbrella({ apiKey, fetch: async () => new Response(frames + 'event: status\ndata: {"status":"succeeded"}\n\n') });
  let outputs = 0;
  for await (const event of new Execution(client.connect({ id: 'small', createdAt }), id).events()) if (event.type === 'stdout') outputs++;
  assert.equal(outputs, 200);
  const bad = new Mainbrella({ apiKey, fetch: async () => new Response('event: stdout\ndata: {') });
  await assert.rejects(async () => { for await (const event of new Execution(bad.connect({ id: 'small', createdAt }), id).events()) {} },
    { code: 'execution_stream_unavailable', cursor: 0 });
});

test('size stays attached to retries and invalid sizes fail before a request', async () => {
  const calls = [];
  const client = new Mainbrella({ apiKey, fetch: async (url, options) => {
    calls.push(options);
    if (calls.length === 1) return Response.json({ error: 'containers_unavailable' }, { status: 503 });
    return Response.json({ creation: { id: 'sized-operation', containerId: 'small', createdAt, status: 'running' },
      containers: [{ id: 'small', createdAt, status: 'running', instance: 'standard-2' }] });
  } });
  const sandbox = await client.create({ size: 'medium', catalogId: 'node', idempotencyKey: 'sized-key', pollIntervalMs: 1 });
  assert.equal(sandbox.instance, 'standard-2');
  assert.equal(calls.length, 2);
  for (const options of calls) assert.deepEqual(JSON.parse(options.body), { catalogId: 'node', size: 'medium' });
  await assert.rejects(client.create({ size: 'basic' }), { code: 'invalid_creation_options' });
  assert.equal(calls.length, 2);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
const { Mainbrella, MainbrellaError, Execution, verifyWebhookSignature } = await import(process.env.MAINBRELLA_SDK_MODULE || './index.js');

const apiKey = `mb_${'a'.repeat(64)}`;
const createdAt = '2026-10-05T12:00:00.000Z';

test('installed client completes a real HTTP lifecycle, rotated replay, cancellation and owned cleanup', async () => {
  const existing = { id: 'small', createdAt: '2026-01-01T00:00:00.000Z', status: 'running' };
  const created = { id: 'c1', createdAt, status: 'running' };
  const jobId = 'd688d42a-25ef-4c13-9b28-21a0fde6e163';
  let file, creationKey, streams = 0, deleted = false, canceled = false;
  const errors = [];
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      assert.equal(request.headers.authorization, `Bearer ${apiKey}`);
      const json = (value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
      if (url.pathname === '/capabilities') return json({ execution: { foreground: true, streaming: true } });
      if (url.pathname === '/containers' && request.method === 'POST') {
        const key = request.headers['idempotency-key'];
        assert.ok(key); assert.ok(!creationKey || key === creationKey); creationKey = key;
        assert.deepEqual(JSON.parse(body), { catalogId: 'node' });
        return json({ creation: { id: 'created-operation', containerId: created.id, createdAt, status: 'running' }, containers: [existing, created] });
      }
      if (url.pathname === '/containers' && request.method === 'GET') return json({ containers: deleted ? [existing] : [existing, created] });
      assert.equal(url.searchParams.get('id'), created.id);
      assert.equal(url.searchParams.get('createdAt'), createdAt);
      if (url.pathname === '/containers' && request.method === 'DELETE') { deleted = true; return json({ containers: [existing] }); }
      if (url.pathname === '/containers/exec') return json({ stdout: 'hello', stderr: 'diagnostic', exitCode: 7, timedOut: false, outputTruncated: false });
      if (url.pathname === '/containers/files') {
        assert.equal(url.searchParams.get('path'), '/tmp/界 &?.bin');
        if (request.method === 'PUT') { file = body; return json({ size: file.length }); }
        response.writeHead(200, { 'content-type': 'application/octet-stream' }); return response.end(file);
      }
      if (url.pathname === '/containers/executions') {
        assert.ok(request.headers['idempotency-key']); return json({ id: jobId }, 201);
      }
      if (url.pathname.endsWith('/events')) {
        assert.equal(url.searchParams.get('cursor'), String(streams));
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        return response.end(streams++ === 0
          ? 'id: 1\nevent: stdout\ndata: {"sequence":1,"type":"stdout","data":"héllo 界"}\n\nevent: status\ndata: {"status":"running"}\n\n'
          : 'id: 1\nevent: stdout\ndata: {"sequence":1,"type":"stdout","data":"duplicate"}\n\nid: 2\nevent: stderr\ndata: {"sequence":2,"type":"stderr","data":"done"}\n\nevent: status\ndata: {"status":"succeeded"}\n\n');
      }
      assert.equal(url.pathname, `/containers/executions/${jobId}`);
      if (request.method === 'DELETE') canceled = true;
      return json({ id: jobId, status: canceled ? 'canceled' : 'succeeded' });
    } catch (error) { errors.push(error); response.writeHead(500); response.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = new Mainbrella({ apiKey, baseUrl: `http://127.0.0.1:${server.address().port}` });
    assert.equal((await client.capabilities()).execution.streaming, true);
    const sandbox = await client.create({ catalogId: 'node' });
    try {
      assert.equal((await sandbox.commands.run('command')).exitCode, 7);
      const bytes = new Uint8Array([0, 128, 255]);
      await sandbox.files.write('/tmp/界 &?.bin', bytes);
      assert.deepEqual(await sandbox.files.read('/tmp/界 &?.bin'), bytes);
      const job = await sandbox.commands.start('managed');
      const reconnected = new Execution(sandbox, job.id);
      const output = [];
      for await (const event of reconnected.events()) if (event.type !== 'status') output.push(event.data);
      assert.deepEqual(output, ['héllo 界', 'done']);
      assert.equal(reconnected.cursor, 2);
      assert.equal((await reconnected.wait({ pollIntervalMs: 1 })).status, 'succeeded');
      assert.equal((await job.cancel()).status, 'canceled');
    } finally { await sandbox.kill(); }
    assert.deepEqual((await client.list()).containers, [existing]);
    assert.equal(deleted, true); assert.equal(canceled, true); assert.equal(streams, 2);
    assert.deepEqual(errors, []);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

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

test('filesystem helpers expose bounded pages and exact-generation mutations without retrying', async () => {
  const calls = [];
  const client = new Mainbrella({ apiKey, fetch: async (url, options) => {
    assert.equal(url.searchParams.get('id'), 'c1'); assert.equal(url.searchParams.get('createdAt'), createdAt);
    calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), method: options.method, body: options.body && JSON.parse(options.body) });
    return Response.json({ ok: true });
  } });
  const files = client.connect({ id: 'c1', createdAt }).files;
  const path = '/workspace/界 &?.bin';
  await files.list(path, { limit: 2, offset: 4 }); await files.stat(path, { followSymlinks: true });
  await files.mkdir(path, { recursive: true, mode: '0750' }); await files.remove(path, { recursive: true });
  await files.move(path, '/workspace/moved'); await files.chmod(path, '0640');
  assert.deepEqual(calls.map(c => [c.path, c.method]), [['/containers/files/list', 'GET'], ['/containers/files/stat', 'GET'],
    ['/containers/files/mkdir', 'POST'], ['/containers/files/remove', 'DELETE'], ['/containers/files/move', 'POST'], ['/containers/files/chmod', 'PATCH']]);
  assert.equal(calls[0].query.limit, '2'); assert.equal(calls[0].query.offset, '4');
  assert.equal(calls[1].query.followSymlinks, 'true'); assert.equal(calls[3].query.recursive, 'true');
  assert.deepEqual(calls[2].body, { path, recursive: true, mode: '0750' });
  assert.deepEqual(calls[4].body, { path, destination: '/workspace/moved' }); assert.deepEqual(calls[5].body, { mode: '0640' });
  const failing = new Mainbrella({ apiKey, fetch: async () => { calls.push('failure'); throw new Error('private'); } });
  await assert.rejects(failing.connect({ id: 'c1', createdAt }).files.remove(path), { code: 'transport_unavailable' });
  assert.equal(calls.length, 7);
  assert.throws(() => files.remove(path, { recursive: 'true' }), { code: 'invalid_file_options' });
  assert.throws(() => files.stat(path, { followSymlinks: 'false' }), { code: 'invalid_file_options' });
  assert.equal(calls.length, 7);
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

test('managed process helpers send literal argv, binary input and signals with explicit generation', async () => {
  const id = crypto.randomUUID(), calls = [];
  const client = new Mainbrella({ apiKey, fetch: async (url, options) => {
    assert.equal(url.searchParams.get('id'), 'small'); assert.equal(url.searchParams.get('createdAt'), createdAt);
    calls.push({ path: url.pathname, options });
    if (url.pathname === '/containers/executions' && options.method === 'GET') return Response.json({ executions: [{ id, status: 'running' }] });
    if (url.pathname.endsWith('/stdin') && options.method === 'POST') {
      assert.deepEqual(options.body, new Uint8Array([0, 128, 255]));
      assert.equal(options.headers['Content-Type'], 'application/octet-stream');
      return Response.json({ bytes: 3, stdinClosed: false });
    }
    if (url.pathname.endsWith('/stdin')) return Response.json({ bytes: 0, stdinClosed: true });
    return Response.json({ id, status: 'running' });
  } });
  const sandbox = client.connect({ id: 'small', createdAt });
  const job = await sandbox.commands.start(['cat', '$(literal)'], { stdin: true, cwd: '/workspace', env: { TASK: 'probe' }, idempotencyKey: 'input-key' });
  assert.deepEqual(JSON.parse(calls[0].options.body), { argv: ['cat', '$(literal)'], stdin: true, cwd: '/workspace', env: { TASK: 'probe' } });
  const attached = sandbox.commands.attach(job.id);
  await attached.stdin.write(new Uint8Array([0, 128, 255])); await attached.stdin.close(); await attached.signal('SIGINT');
  assert.deepEqual(JSON.parse(calls[3].options.body), { signal: 'SIGINT' });
  assert.equal((await sandbox.commands.list()).executions[0].id, id);
  assert.throws(() => attached.stdin.write('text'), { code: 'stdin_bytes_required' });
  assert.throws(() => attached.signal('SIGSTOP'), { code: 'invalid_execution_signal' });
  await attached.resize(132, 40);
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { cols: 132, rows: 40 });
  assert.throws(() => attached.resize(0, 24), { code: 'invalid_terminal_size' });
  assert.equal(calls.length, 6);
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

test('lifecycle metrics and webhook helpers preserve generation and never retry configuration', async () => {
  const calls = [];
  const sandbox = new Mainbrella({ apiKey, fetch: async (url, options) => {
    assert.equal(url.searchParams.get('id'), 'small'); assert.equal(url.searchParams.get('createdAt'), createdAt);
    calls.push({ url, options }); return Response.json({ ok: true });
  } }).connect({ id: 'small', createdAt });
  await sandbox.events({ cursor: 1, limit: 10 }); await sandbox.metrics({ from: createdAt, to: createdAt });
  await sandbox.webhook.configure('https://relay.example.com/customer', { replayFromCursor: 0 });
  await sandbox.webhook.get(); await sandbox.webhook.deliveries(); const id = crypto.randomUUID();
  await sandbox.webhook.retry(id); await sandbox.webhook.remove();
  assert.equal(calls[0].url.searchParams.get('cursor'), '1');
  assert.deepEqual(JSON.parse(calls[2].options.body), { url: 'https://relay.example.com/customer', replayFromCursor: 0 });
  assert.deepEqual(JSON.parse(calls[5].options.body), { eventId: id });
  assert.throws(() => sandbox.webhook.retry('bad'), { code: 'invalid_event_identity' }); assert.equal(calls.length, 7);
  let attempts = 0; const fail = new Mainbrella({ apiKey, fetch: async () => { attempts++; throw Error('private'); } }).connect({ id: 'small', createdAt });
  await assert.rejects(fail.webhook.configure('https://relay.example.com/customer'), { code: 'transport_unavailable' }); assert.equal(attempts, 1);
});

test('webhook verification authenticates raw bytes and rejects changes, stale/future signatures and duplicate fields', async () => {
  const secret = `mbwh_${'a'.repeat(64)}`, bytes = new TextEncoder().encode('{ "message": "héllo 界" }'), timestamp = 1000;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signed = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.` + new TextDecoder().decode(bytes))));
  const signature = `t=${timestamp},v1=${[...signed].map(value => value.toString(16).padStart(2, '0')).join('')}`;
  assert.equal(await verifyWebhookSignature(bytes, signature, secret, { nowMs: 1000_000 }), true);
  assert.equal(await verifyWebhookSignature(new Uint8Array([...bytes, 32]), signature, secret, { nowMs: 1000_000 }), false);
  assert.equal(await verifyWebhookSignature(bytes, signature, `mbwh_${'b'.repeat(64)}`, { nowMs: 1000_000 }), false);
  for (const nowMs of [1301_000, 699_000, NaN]) assert.equal(await verifyWebhookSignature(bytes, signature, secret, { nowMs }), false);
  assert.equal(await verifyWebhookSignature(bytes, signature + ',extra=1', secret, { nowMs: 1000_000 }), false);
});

test('internet-off creation requires discovery, rejects ignored policy and does not retry unavailable policy', async () => {
  const calls = [], client = new Mainbrella({ apiKey, fetch: async (url, options) => {
    calls.push({ path: new URL(url).pathname, options });
    return Response.json({ networking: { internetControl: false } });
  } });
  await assert.rejects(client.create({ internet: false, idempotencyKey: 'offline' }), { code: 'network_policy_unavailable', idempotencyKey: 'offline' });
  assert.deepEqual(calls.map(item => item.path), ['/capabilities']);
  for (const internet of ['false', 0, null, {}]) await assert.rejects(client.create({ internet }), { code: 'invalid_creation_options' });
  assert.equal(calls.length, 1);
  let policy = false;
  const supported = new Mainbrella({ apiKey, fetch: async (url, options) => {
    if (new URL(url).pathname === '/capabilities') return Response.json({ networking: { internetControl: true } });
    assert.equal(JSON.parse(options.body).internet, false);
    return Response.json({ creation: { id: 'offline', containerId: 'small', createdAt, status: 'running' }, containers: [{ id: 'small', createdAt, status: 'running', internet: policy }] });
  } });
  assert.equal((await supported.create({ internet: false })).internet, false);
  policy = true; await assert.rejects(supported.create({ internet: false }), { code: 'network_policy_unconfirmed' });
  let posts = 0;
  const unavailable = new Mainbrella({ apiKey, fetch: async url => {
    if (new URL(url).pathname === '/capabilities') return Response.json({ networking: { internetControl: true } });
    posts++; return Response.json({ error: 'network_policy_unavailable' }, { status: 503 });
  } });
  await assert.rejects(unavailable.create({ internet: false, waitTimeoutMs: 1000 }), { code: 'network_policy_unavailable' }); assert.equal(posts, 1);
});

test('workspace save retains recovery identity on lost response and export preserves bytes',async()=>{
  const calls=[];let lost=true;
  const client=new Mainbrella({apiKey,fetch:async(url,options)=>{
    calls.push({path:new URL(url).pathname,options});
    if(new URL(url).pathname==='/workspaces'){if(lost){lost=false;throw new Error('lost');}return Response.json({id:'d688d42a-25ef-4c13-9b28-21a0fde6e163'});}
    return new Response(new Uint8Array([0,255,128]));
  }});const sandbox=client.connect({id:'small',createdAt});
  await assert.rejects(sandbox.saveWorkspace('Saved files',{stop:true,idempotencyKey:'save-recovery'}),error=>error.idempotencyKey==='save-recovery');
  await sandbox.saveWorkspace('Saved files',{stop:true,idempotencyKey:'save-recovery'});
  assert.equal(calls[0].options.body,calls[1].options.body);assert.equal(calls[1].options.headers['Idempotency-Key'],'save-recovery');
  assert.deepEqual(await sandbox.exportWorkspace(),new Uint8Array([0,255,128]));
});
test('workspace restore fails closed on disabled discovery before any start',async()=>{
  const calls=[];const client=new Mainbrella({apiKey,fetch:async(url)=>{calls.push(new URL(url).pathname);return Response.json({persistence:{snapshots:false}});}});
  await assert.rejects(client.workspaces.restore('d688d42a-25ef-4c13-9b28-21a0fde6e163',{idempotencyKey:'restore-recovery'}),error=>error.code==='persistence_unavailable'&&error.idempotencyKey==='restore-recovery');
  assert.deepEqual(calls,['/capabilities']);assert.throws(()=>client.workspaces.get('other'),/invalid_workspace_identity/);
});

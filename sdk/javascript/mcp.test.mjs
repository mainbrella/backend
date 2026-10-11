import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
const { createMcpServer, serveMcp } = await import(process.env.MAINBRELLA_SDK_MCP || './mcp.mjs');
const { Mainbrella } = await import(process.env.MAINBRELLA_SDK_MODULE || './index.js');

const key = 'mb_' + 'a'.repeat(64), generation = '2026-10-11T12:00:00.000Z';
const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });
const init = rpc(1, 'initialize', { protocolVersion: '2025-11-25', clientInfo: { name: 'test', version: '1' }, capabilities: {} });
async function ready(handle) { assert.equal((await handle(init)).result.protocolVersion, '2025-11-25'); await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }); }

test('MCP negotiates initialization, publishes schemas, rejects invalid tools and arguments before requests', async () => {
  let calls = 0;
  const handle = createMcpServer(new Mainbrella({ apiKey: key, fetch: async () => { calls++; return Response.json({}); } }));
  assert.equal((await handle(rpc(0, 'tools/list'))).error.code, -32000);
  assert.equal((await handle(rpc(0, 'initialize', { protocolVersion: '2025-11-25', clientInfo: true, capabilities: 'x' }))).error.code, -32602);
  await ready(handle);
  const list = (await handle(rpc(2, 'tools/list'))).result.tools;
  assert.equal(new Set(list.map(x => x.name)).size, list.length);
  assert.equal(list.find(x => x.name === 'mainbrella_delete').annotations.destructiveHint, true);
  assert.equal(list.find(x => x.name === 'mainbrella_save').annotations.destructiveHint, true);
  assert.equal(list.find(x => x.name === 'mainbrella_list').annotations.readOnlyHint, true);
  for (const params of [{ name: 'missing' }, { name: 'mainbrella_create', arguments: {} },
    { name: 'mainbrella_run', arguments: { id: 'small', createdAt: generation, command: 'true', timeoutMs: -1 } },
    { name: 'mainbrella_run', arguments: { id: 'small', createdAt: generation, command: 'true', apiKey: key } }]) {
    assert.equal((await handle(rpc(3, 'tools/call', params))).error.code, -32602);
  }
  assert.equal(calls, 0);
  assert.equal((await handle(rpc(4, 'unknown'))).error.code, -32601);
  assert.equal((await handle([init])).error.code, -32600);
});

test('MCP binds operations to generations, preserves reconciliation keys and sanitizes transport failures', async () => {
  const calls = [];
  const handle = createMcpServer(new Mainbrella({ apiKey: key, fetch: async (url, options) => {
    calls.push({ url, options });
    if (url.pathname === '/containers/exec') return Response.json({ stdout: 'ok', exitCode: 0 });
    throw new Error(key + ' private error');
  } }));
  await ready(handle);
  const result = await handle(rpc(2, 'tools/call', { name: 'mainbrella_run', arguments: { id: 'small', createdAt: generation, command: 'echo ok' } }));
  assert.deepEqual(JSON.parse(result.result.content[0].text), { stdout: 'ok', exitCode: 0 });
  assert.equal(calls[0].url.searchParams.get('createdAt'), generation);
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${key}`);
  const failure = await handle(rpc(3, 'tools/call', { name: 'mainbrella_stop', arguments: { id: 'small', createdAt: generation, idempotencyKey: 'retry-me' } }));
  assert.equal(failure.result.isError, true);
  assert.deepEqual(JSON.parse(failure.result.content[0].text), { error: 'transport_unavailable', idempotencyKey: 'retry-me' });
  assert.ok(!JSON.stringify(failure).includes(key));
});

test('stdio handles split UTF-8 frames, malformed JSON and notifications without contaminating stdout', async () => {
  const body = [init, { jsonrpc: '2.0', method: 'notifications/initialized' }, rpc(2, 'tools/call', { name: 'mainbrella_list' })]
    .map(JSON.stringify).join('\n') + '\n{bad}\n';
  const buffer = Buffer.from(body), chunks = Array.from({ length: buffer.length }, (_, i) => buffer.subarray(i, i + 1));
  let stdout = '';
  await serveMcp({ input: Readable.from(chunks), output: new Writable({ write(chunk, _encoding, done) { stdout += chunk; done(); } }),
    env: { MAINBRELLA_API_KEY: key }, fetch: async () => Response.json({ containers: [{ name: 'café' }] }) });
  const responses = stdout.trim().split('\n').map(JSON.parse);
  assert.equal(responses.length, 3);
  assert.equal(JSON.parse(responses[1].result.content[0].text).containers[0].name, 'café');
  assert.equal(responses[2].error.code, -32700);
});

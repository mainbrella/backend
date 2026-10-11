import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from './router';
import { MAX_TRANSFER_BYTES } from '../../containers/file-transfer-contract.js';
import { paidContainerFixture, GENERATION_ONE, GENERATION_TWO, EXPIRES_AT, SESSION_ONE, USER_ONE } from './paid-container-test-helpers';

function request(method = 'GET', body?: BodyInit, extra: Record<string, string> = {}, headers: Record<string, string> = {}) {
  const query = new URLSearchParams({ id: 'small', createdAt: GENERATION_ONE, path: '/workspace/file.bin', ...extra });
  return new Request(`https://api.mainbrella.com/containers/files/transfer?${query}`, { method, body, duplex: 'half',
    headers: { Origin: 'https://mainbrella.com', Cookie: `mainbrella_session=${SESSION_ONE}`, ...headers } } as RequestInit);
}

test('transfer proxy authenticates before reading uploads and enforces generation, size and CSRF', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  let reads = 0;
  const body = new ReadableStream({ pull() { reads++; } }, { highWaterMark: 0 });
  assert.equal((await handleRequest(request('PUT', body, { size: '3' }, { Cookie: '' }), f.env)).status, 401);
  assert.equal(reads, 0);
  for (const size of ['-1', '01', String(MAX_TRANSFER_BYTES + 1), '']) assert.equal((await handleRequest(request('PUT', undefined, { size }), f.env)).status, 400);
  assert.equal((await handleRequest(request('PUT', undefined, { size: '0' }, { Origin: '' }), f.env)).status, 403);
  assert.equal((await handleRequest(request('GET', undefined, { createdAt: GENERATION_TWO }), f.env)).status, 409);
  f.containers.get(USER_ONE)![0].expiresAt = GENERATION_ONE;
  assert.equal((await handleRequest(request(), f.env)).status, 409);
  f.containers.get(USER_ONE)![0].expiresAt = EXPIRES_AT;
  f.setBillingMode('unpaid'); assert.equal((await handleRequest(request(), f.env)).status, 402);
  assert.equal(f.machineCalls.length, 0);
});

test('download passes raw streams with sanitized headers and propagates cancellation and truncation', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  let canceled = false, sent = false;
  const original = f.env.USER_CONTAINER;
  f.env.USER_CONTAINER = { ...original, get(id: DurableObjectId) { original.get(id); return { async fetch(req: Request) {
    assert.equal(new URL(req.url).pathname, '/files/transfer');
    assert.equal(req.headers.get('x-exec-created-at'), GENERATION_ONE);
    assert.equal(req.headers.get('authorization'), null);
    return new Response(new ReadableStream({ pull(c) { if (!sent) { c.enqueue(new Uint8Array([0, 255])); sent = true; } }, cancel() { canceled = true; } }),
      { headers: { 'content-length': '2', 'set-cookie': 'private', 'content-type': 'text/html' } });
  } }; } } as unknown as DurableObjectNamespace;
  const response = await handleRequest(request(), f.env);
  assert.equal(response.status, 200); assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  const reader = response.body!.getReader(); assert.deepEqual((await reader.read()).value, new Uint8Array([0, 255]));
  await reader.cancel(); assert.equal(canceled, true);
  f.env.USER_CONTAINER = { ...original, get() { return { async fetch() { return new Response(new Uint8Array([1]), { headers: { 'content-length': '2' } }); } }; } } as unknown as DurableObjectNamespace;
  await assert.rejects((await handleRequest(request(), f.env)).arrayBuffer(), /file_size_mismatch/);
});

test('upload forwards streaming body and only exposes documented runtime errors', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  const original = f.env.USER_CONTAINER;
  let supplied = false;
  const body = new ReadableStream({ pull(c) { supplied = true; c.enqueue(new Uint8Array([0, 255])); c.close(); } }, { highWaterMark: 0 });
  f.env.USER_CONTAINER = { ...original, get() { return { async fetch(req: Request) {
    assert.equal(supplied, false); assert.equal(new URL(req.url).searchParams.get('size'), '2');
    assert.deepEqual(new Uint8Array(await req.arrayBuffer()), new Uint8Array([0, 255]));
    return Response.json({ path: '/private', size: 99 });
  } }; } } as unknown as DurableObjectNamespace;
  const response = await handleRequest(request('PUT', body, { size: '2' }), f.env);
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { path: '/workspace/file.bin', size: 2 });
  for (const [status, error, expected] of [[400, 'file_size_mismatch', 400], [409, 'not_regular_file', 409], [500, 'private', 503]] as const) {
    f.env.USER_CONTAINER = { ...original, get() { return { async fetch() { return Response.json({ error }, { status }); } }; } } as unknown as DurableObjectNamespace;
    assert.equal((await handleRequest(request(), f.env)).status, expected);
  }
});

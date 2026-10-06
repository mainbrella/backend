import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from './router';
import { executionSchema } from './openapi-executions';
import { MAX_STDIN_CHUNK_BYTES } from '../../containers/execution-contract.js';
import { paidContainerFixture, GENERATION_ONE, GENERATION_TWO, SESSION_ONE, USER_ONE } from './paid-container-test-helpers';

const executionId = 'd688d42a-25ef-4c13-9b28-21a0fde6e163';
const record = { id: executionId, createdAt: GENERATION_ONE, startedAt: GENERATION_ONE, status: 'running', retainUntil: Date.now() + 3600_000,
  cursor: 0, outputBytes: 0, exitCode: null, timedOut: false, outputTruncated: false };
const query = new URLSearchParams({ id: 'small', createdAt: GENERATION_ONE });
function request(path = '', method = 'GET', body?: string, headers: Record<string, string> = {}, parameters = query.toString()) {
  return new Request(`https://api.mainbrella.com/containers/executions${path}?${parameters}`, { method, body,
    headers: { Origin: 'https://mainbrella.com', Cookie: `mainbrella_session=${SESSION_ONE}`, 'Idempotency-Key': 'job-one', ...headers } });
}
test('managed start preserves trusted identity; read/cancel/stream stay available during billing outages', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  const calls: Request[] = [];
  const original = f.env.USER_CONTAINER;
  f.env.USER_CONTAINER = { ...original, get(id: DurableObjectId) {
    original.get(id);
    return { async fetch(req: Request) {
      calls.push(req);
      if (new URL(req.url).pathname.endsWith('/events')) return new Response('event: stdout\ndata: {}\n\n', { headers: { 'set-cookie': 'private' } });
      return Response.json(record, { status: req.method === 'GET' ? 200 : 202 });
    } };
  } } as unknown as DurableObjectNamespace;
  const start = await handleRequest(request('', 'POST', '{"command":"printf hello","timeoutMs":90000}', { 'x-user-id': 'victim', 'x-exec-created-at': GENERATION_TWO }), f.env);
  assert.equal(start.status, 202); executionSchema.parse(await start.json());
  assert.equal(calls[0].headers.get('x-exec-created-at'), GENERATION_ONE);
  assert.equal(calls[0].headers.get('cookie'), null); assert.equal(calls[0].headers.get('x-user-id'), null);
  f.setBillingMode('failure');
  assert.equal((await handleRequest(request(`/${executionId}`), f.env)).status, 200);
  assert.equal((await handleRequest(request(`/${executionId}`, 'DELETE'), f.env)).status, 202);
  const stream = await handleRequest(request(`/${executionId}/events`, 'GET'), f.env);
  assert.equal(stream.headers.get('content-type'), 'text/event-stream');
  assert.equal(stream.headers.get('set-cookie'), null);
  assert.equal(await stream.text(), 'event: stdout\ndata: {}\n\n');
  assert.equal((await handleRequest(request('', 'POST', '{"command":"printf hello"}'), f.env)).status, 503);
  assert.ok(f.machineNames.every(name => name === 'user:account-one'));
});
test('managed execution validates authentication, input, lease and endpoint methods before launch', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  assert.equal((await handleRequest(request('', 'POST', '{"command":"x"}', { Cookie: '' }), f.env)).status, 401);
  assert.equal((await handleRequest(request('', 'POST', '{"command":"x"}', { Origin: '' }), f.env)).status, 403);
  assert.equal((await handleRequest(request('', 'POST', '{"command":"x"}', { 'Idempotency-Key': '' }), f.env)).status, 400);
  assert.equal((await handleRequest(request('', 'POST', '{"command":"x","timeoutMs":900001}'), f.env)).status, 400);
  assert.equal((await handleRequest(request('', 'POST', '{"command":"x"}', {}, `${query}&id=c1`), f.env)).status, 400);
  assert.equal((await handleRequest(request(`/${executionId}/events`, 'GET', undefined, {}, `${query}&cursor=-1`), f.env)).status, 400);
  assert.equal((await handleRequest(request('', 'PUT'), f.env)).status, 405);
  f.containers.get(USER_ONE)![0].createdAt = GENERATION_TWO;
  assert.equal((await handleRequest(request('', 'POST', '{"command":"x"}'), f.env)).status, 409);
  assert.equal(f.machineCalls.length, 0);
});

test('managed input/list/signal routes preserve owned identities, input bytes and cleanup during billing outages', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  const original = f.env.USER_CONTAINER, calls: Request[] = [];
  f.env.USER_CONTAINER = { ...original, get(id: DurableObjectId) {
    original.get(id);
    return { async fetch(req: Request) {
      calls.push(req);
      const path = new URL(req.url).pathname;
      if (path.endsWith('/stdin') && req.method === 'POST') {
        assert.deepEqual(new Uint8Array(await req.arrayBuffer()), new Uint8Array([0, 128, 255]));
        return Response.json({ bytes: 3, stdinClosed: false });
      }
      if (path.endsWith('/stdin')) return Response.json({ bytes: 0, stdinClosed: true });
      if (path.endsWith('/signal')) { assert.deepEqual(await req.json(), { signal: 'SIGINT' }); return Response.json(record, { status: 202 }); }
      return Response.json({ executions: [record] });
    } };
  } } as unknown as DurableObjectNamespace;
  const write = new Request(request(`/${executionId}/stdin`, 'POST', 'placeholder'), { body: new Uint8Array([0, 128, 255]) });
  assert.equal((await handleRequest(write, f.env)).status, 200);
  assert.equal(calls[0].headers.get('x-exec-created-at'), GENERATION_ONE);
  assert.equal(calls[0].headers.get('content-type'), 'application/octet-stream');
  assert.ok(calls[0].headers.get('x-exec-expires-at'));
  assert.equal(calls[0].headers.get('cookie'), null);
  f.setBillingMode('failure');
  assert.equal((await handleRequest(request('', 'GET'), f.env)).status, 200);
  assert.equal((await handleRequest(request(`/${executionId}/stdin`, 'DELETE'), f.env)).status, 200);
  assert.equal((await handleRequest(request(`/${executionId}/signal`, 'POST', '{"signal":"SIGINT"}'), f.env)).status, 202);
  assert.equal((await handleRequest(new Request(write, { body: new Uint8Array([0, 128, 255]) }), f.env)).status, 503);
  assert.ok(f.machineNames.every(name => name === 'user:account-one'));
  assert.ok(calls.slice(1).every(call => call.headers.get('x-exec-expires-at') === null));
});

test('managed input/signal validation rejects oversized bytes, arbitrary PID targets and stale writes', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  const tooLarge = new Request(request(`/${executionId}/stdin`, 'POST', 'placeholder'), { body: new Uint8Array(MAX_STDIN_CHUNK_BYTES + 1) });
  assert.equal((await handleRequest(tooLarge, f.env)).status, 413);
  for (const body of ['{"signal":"SIGSTOP"}', '{"signal":"SIGKILL","pid":1}', 'null', 'true']) {
    assert.equal((await handleRequest(request(`/${executionId}/signal`, 'POST', body), f.env)).status, 400);
  }
  assert.equal((await handleRequest(request(`/${executionId}/signal`, 'POST', '{"signal":"SIGINT"}', { Origin: '' }), f.env)).status, 403);
  assert.equal((await handleRequest(request(`/${executionId}/stdin`, 'GET'), f.env)).status, 405);
  f.containers.get(USER_ONE)![0].createdAt = GENERATION_TWO;
  assert.equal((await handleRequest(request(`/${executionId}/stdin`, 'POST', 'input'), f.env)).status, 409);
  assert.equal(f.machineCalls.length, 0);
});

test('PTY resize validates dimensions, running paid generation and private forwarding', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  const calls: Request[] = [];
  f.env.USER_CONTAINER = { idFromName(name: string) { f.machineNames.push(name); return name; }, get() { return {
    async fetch(req: Request) { calls.push(req); assert.deepEqual(await req.json(), { cols: 132, rows: 40 }); return Response.json({ id: executionId, pty: { cols: 132, rows: 40 } }); },
  }; } } as unknown as DurableObjectNamespace;
  const resize = () => request(`/${executionId}/resize`, 'POST', '{"cols":132,"rows":40}');
  assert.equal((await handleRequest(resize(), f.env)).status, 200);
  assert.equal(calls[0].headers.get('x-exec-created-at'), GENERATION_ONE);
  assert.ok(calls[0].headers.get('x-exec-expires-at'));
  assert.equal(calls[0].headers.get('cookie'), null);
  for (const body of ['{"cols":0,"rows":24}', '{"cols":80,"rows":1001}', '{"cols":80}', '{"cols":80,"rows":24,"pid":1}', 'true']) {
    assert.equal((await handleRequest(request(`/${executionId}/resize`, 'POST', body), f.env)).status, 400);
  }
  f.containers.get(USER_ONE)![0].createdAt = GENERATION_TWO;
  assert.equal((await handleRequest(resize(), f.env)).status, 409);
  assert.equal(calls.length, 1);
  f.containers.get(USER_ONE)![0].createdAt = GENERATION_ONE; f.setBillingMode('failure');
  assert.equal((await handleRequest(resize(), f.env)).status, 503);
});

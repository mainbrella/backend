import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from './router';
import { paidContainerFixture, GENERATION_ONE, GENERATION_TWO, USER_ONE, SESSION_ONE, SESSION_TWO } from './paid-container-test-helpers';
const eventId = 'd688d42a-25ef-4c13-9b28-21a0fde6e163';
function request(method = 'GET', body?: string, suffix = '', extra: Record<string,string> = {}) {
  return new Request(`https://api.mainbrella.com/containers/webhook${suffix}?id=small&createdAt=${GENERATION_ONE}`, { method, body,
    headers: { Origin: 'https://mainbrella.com', Cookie: `mainbrella_session=${SESSION_ONE}`, ...extra } });
}
test('webhook configuration forwards trusted identity/expiry and owned cleanup survives billing outages', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  f.env.WORKLOAD_WEBHOOKS_ENABLED = 'true'; f.env.WEBHOOK_ALLOWED_HOSTS = 'relay.example.com';
  const calls: { name: string; request: Request }[] = [];
  f.env.USER_CONTAINER = { idFromName(name: string) { return name; }, get(name: string) { return { async fetch(req: Request) {
    calls.push({ name, request: req });
    if (name !== 'user:' + USER_ONE) return Response.json({ webhook: null });
    if (req.method === 'PUT') return Response.json({ webhook: { url: 'https://relay.example.com/callback' }, signingSecret: 'mbwh_test' }, { status: 201, headers: { 'x-private': 'secret', 'set-cookie': 'private' } });
    return Response.json({ removed: true });
  } }; } } as unknown as DurableObjectNamespace;
  const configure = () => request('PUT', '{"url":"https://relay.example.com/callback","replayFromCursor":0}', '', { 'x-exec-created-at': 'victim', 'x-exec-container-id': 'victim' });
  const response = await handleRequest(configure(), f.env); assert.equal(response.status, 201); assert.equal(response.headers.get('set-cookie'), null); assert.equal(response.headers.get('x-private'), null);
  assert.deepEqual([...calls[0].request.headers.keys()].sort(), ['content-type', 'x-exec-container-id', 'x-exec-created-at', 'x-exec-expires-at']);
  assert.equal(calls[0].request.headers.get('x-exec-created-at'), GENERATION_ONE); assert.equal(calls[0].request.headers.get('x-exec-container-id'), 'small');
  f.setBillingMode('failure');
  for (const [method, suffix, body] of [['GET', '', undefined], ['DELETE', '', undefined], ['GET', '/deliveries', undefined], ['POST', '/retry', JSON.stringify({ eventId })]] as const) assert.equal((await handleRequest(request(method, body, suffix), f.env)).status, 200);
  assert.equal((await handleRequest(configure(), f.env)).status, 503);
  assert.ok(calls.slice(1).every(call => call.request.headers.get('x-exec-expires-at') === null));
  assert.equal((await handleRequest(request('GET', undefined, '', { Cookie: `mainbrella_session=${SESSION_TWO}` }), f.env)).status, 200);
  assert.equal(calls.at(-1)!.name, 'user:account-two');
});
test('webhooks reject untrusted destinations, oversized bodies, stale identities and missing origin', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close()); f.env.WORKLOAD_WEBHOOKS_ENABLED = 'true'; f.env.WEBHOOK_ALLOWED_HOSTS = 'relay.example.com';
  assert.equal((await handleRequest(request('PUT', '{"url":"https://relay.example.com/callback"}', '', { Origin: '' }), f.env)).status, 403);
  assert.equal((await handleRequest(request('GET', undefined, '', { Cookie: '' }), f.env)).status, 401);
  for (const body of ['{"url":"https://evil.example.com/"}', '{"url":"https://127.0.0.1/"}', '{"url":"https://relay.example.com/","headers":{"Authorization":"secret"}}', '{"url":"https://relay.example.com/","replayFromCursor":-1}', 'true', 'null']) assert.equal((await handleRequest(request('PUT', body), f.env)).status, 400);
  assert.equal((await handleRequest(request('PUT', JSON.stringify({ url: 'https://relay.example.com/' + 'x'.repeat(4096) })), f.env)).status, 400);
  assert.equal((await handleRequest(request('POST', '{"eventId":"bad"}', '/retry'), f.env)).status, 400);
  assert.equal((await handleRequest(request('POST'), f.env)).status, 405);
  assert.equal((await handleRequest(new Request(request().url + '&createdAt=duplicate', request()), f.env)).status, 400);
  f.containers.get(USER_ONE)![0].createdAt = GENERATION_TWO;
  assert.equal((await handleRequest(request('PUT', '{"url":"https://relay.example.com/"}'), f.env)).status, 409);
  assert.equal(f.machineCalls.length, 0);
  f.env.WORKLOAD_WEBHOOKS_ENABLED = 'false'; assert.equal((await handleRequest(request('PUT', '{"url":"https://relay.example.com/"}'), f.env)).status, 503);
});
test('documented delivery failures survive forwarding while internal errors remain sanitized', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close()); f.env.WORKLOAD_WEBHOOKS_ENABLED = 'true'; f.env.WEBHOOK_ALLOWED_HOSTS = 'relay.example.com';
  for (const [status, error] of [[404, 'delivery_not_found'], [409, 'delivery_not_retryable'], [429, 'webhook_retry_limit'], [503, 'webhooks_not_configured']] as const) {
    f.env.USER_CONTAINER = { idFromName() { return 'owned'; }, get() { return { fetch: async () => Response.json({ error, private: 'secret' }, { status }) }; } } as unknown as DurableObjectNamespace;
    const response = await handleRequest(request('POST', JSON.stringify({ eventId }), '/retry'), f.env); assert.equal(response.status, status); assert.deepEqual(await response.json(), { error });
  }
  for (const response of [Response.json({ error: 'private' }, { status: 500 }), new Response('private malformed body')]) {
    f.env.USER_CONTAINER = { idFromName() { return 'owned'; }, get() { return { fetch: async () => response }; } } as unknown as DurableObjectNamespace;
    const result = await handleRequest(request(), f.env); assert.equal(result.status, 503); assert.deepEqual(await result.json(), { error: 'webhooks_unavailable' });
  }
});

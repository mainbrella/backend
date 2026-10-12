import assert from 'node:assert/strict';
import test from 'node:test';
import { handleSecurityRelay } from './security-relay';
import { handleSecurityAcknowledgment } from './security-ack';

const token = 'operator-'.padEnd(64, 'a'), runId = '11111111-1111-4111-8111-111111111111';
test('relay authenticates before accessing a container and preserves the admitted envelope', async () => {
  let calls = 0, received: Request | undefined;
  const env = { EGRESS_RELAY_TOKEN: token, EGRESS_RELAY: {
    idFromName: (name: string) => { assert.equal(name, 'relay'); return name; },
    get: () => ({ fetch: async (request: Request) => { calls++; received = request; return new Response('forwarded', { status: 200 }); } }),
  } } as unknown as Env;
  const call = (path = '/v1/egress', authorization = `Bearer ${token}`, method = 'POST') => handleSecurityRelay(new Request('https://relay.example.com' + path, {
    method, headers: { Authorization: authorization }, ...(method === 'POST' ? { body: '{"raw":"unchanged"}' } : {}),
  }), env);
  for (const args of [['/v1/egress', 'Bearer wrong'], ['/v1/egress?url=target'], ['/v1/egress', `Bearer ${token}`, 'GET'], ['/arbitrary']]) assert.equal((await call(...args as [string, string?, string?])).status, 403);
  assert.equal(calls, 0);
  assert.equal((await call()).status, 200); assert.equal(calls, 1);
  assert.equal(await received!.text(), '{"raw":"unchanged"}');
});
test('upstream controls require their separate operator token and route by exact run ID', async () => {
  let calls = 0;
  const env = { SECURITY_ACK_CONTROL_TOKEN: token, SECURITY_ACK: { idFromName: (name: string) => { assert.equal(name, runId); return name; },
    get: () => ({ fetch: async () => { calls++; return Response.json({ ok: true }); } }),
  } } as unknown as Env;
  const call = (path: string, authorization = '') => handleSecurityAcknowledgment(new Request('https://ack.example.com' + path, { headers: { Authorization: authorization } }), env);
  assert.equal((await call(`/control/${runId}`)).status, 403); assert.equal(calls, 0);
  assert.equal((await call(`/control/${runId}`, `Bearer ${token}`)).status, 200);
  assert.equal((await call(`/runs/${runId}/public`)).status, 200);
  assert.equal((await call('/runs/not-a-run/public')).status, 404);
  assert.equal((await call(`/control/${runId}?value=spoof`, `Bearer ${token}`)).status, 404);
  assert.equal(calls, 2);
});

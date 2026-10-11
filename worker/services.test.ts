import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from './app/router';
import { handleAdminServiceRequest } from './admin';
import { handleMarketingServiceRequest } from './marketing';

const origin = 'https://raindrop.mainbrella.com';

test('API forwards every admin route and marketing endpoint to its owning service', async () => {
  for (const [path, binding] of [
    ['/admin/users', 'ADMIN_API'], ['/admin/users/user%2Fone?limit=4&fundingCursor=next', 'ADMIN_API'],
    ['/admin/tables/users?q=long%20name&offset=25', 'ADMIN_API'], ['/admin/accounting/ledger', 'ADMIN_API'],
    ['/admin/accounting/closes', 'ADMIN_API'], ['/admin/accounting/policies', 'ADMIN_API'],
    ['/admin/accounting/storage-invoices', 'ADMIN_API'], ['/admin/acquisition/leads', 'ADMIN_API'],
    ['/admin/acquisition/events', 'ADMIN_API'], ['/api/get-marketing-users?limit=10', 'ADMIN_API'],
    ['/api/send-marketing-email', 'MARKETING_API'], ['/api/unsubscribe', 'MARKETING_API'],
  ]) {
    const request = new Request(`https://api.mainbrella.com${path}`, {
      headers: { Cookie: 'mainbrella_session=original', Origin: origin, 'x-request-id': 'test' },
    });
    const response = Response.json({ service: binding }, { status: 409, headers: { 'x-service-response': 'preserved' } });
    let calls = 0;
    const env = { [binding]: { async fetch(received: Request) {
      calls++;
      assert.equal(received, request, path);
      return response;
    } }, DB: { prepare() { throw new Error('Gateway must not run the feature handler'); } } } as unknown as Env;
    assert.equal(await handleRequest(request, env), response, path);
    assert.equal(calls, 1, path);
  }
});

test('service forwarding preserves raw bodies, OPTIONS, HEAD and response streams', async () => {
  for (const method of ['POST', 'OPTIONS', 'HEAD', 'DELETE']) {
    const request = new Request('https://api.mainbrella.com/api/send-marketing-email?original=yes', {
      method, headers: { Origin: origin, Cookie: 'mainbrella_session=original' },
      ...(['POST', 'DELETE'].includes(method) ? { body: 'intentionally invalid JSON' } : {}),
    });
    const response = new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('streamed response'));
      controller.close();
    } }), { status: 405, headers: { allow: 'POST, OPTIONS', 'access-control-allow-origin': origin } });
    const env = { MARKETING_API: { async fetch(received: Request) {
      assert.equal(received, request);
      assert.equal(received.method, method);
      if (['POST', 'DELETE'].includes(method)) assert.equal(await received.text(), 'intentionally invalid JSON');
      return response;
    } } } as unknown as Env;
    const actual = await handleRequest(request, env);
    assert.equal(actual, response);
    assert.equal(actual.headers.get('allow'), 'POST, OPTIONS');
    assert.equal(await actual.text(), 'streamed response');
  }
});

test('missing or failing service bindings return safe credentialed errors without retries', async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    for (const [path, binding, error] of [
      ['/admin/users', 'ADMIN_API', 'admin_unavailable'],
      ['/api/send-marketing-email', 'MARKETING_API', 'marketing_unavailable'],
      ['/api/unsubscribe', 'MARKETING_API', 'marketing_unavailable'],
    ]) {
      let calls = 0;
      for (const env of [{}, { [binding]: { async fetch() { calls++; throw new Error('private credential details'); } } }]) {
        const response = await handleRequest(new Request(`https://api.mainbrella.com${path}`, { headers: { Origin: origin } }), env as unknown as Env);
        assert.equal(response.status, 503);
        assert.equal(response.headers.get('access-control-allow-origin'), origin);
        assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.deepEqual(await response.json(), { error });
      }
      assert.equal(calls, 1, 'A failed send must never be retried by the gateway');
    }
    const blocked = await handleRequest(new Request('https://api.mainbrella.com/admin/users', {
      headers: { Origin: 'https://example.com' },
    }), {} as Env);
    assert.equal(blocked.status, 403);
    assert.deepEqual(await blocked.json(), { error: 'origin_not_allowed' });
  } finally { console.error = originalError; }
});

test('private Workers retain their own authentication and reject unrelated product endpoints', async () => {
  const env = { ACQUISITION_ENABLED: 'true', DB: { prepare() { throw new Error('Unauthenticated request reached DB'); } } } as unknown as Env;
  for (const path of ['/admin/users', '/admin/tables', '/admin/accounting/ledger', '/admin/acquisition/leads', '/admin/accounting/storage-invoices', '/api/get-marketing-users']) {
    const response = await handleAdminServiceRequest(new Request(`https://api.mainbrella.com${path}`, { headers: { Origin: origin } }), env);
    assert.equal(response.status, 401, path);
  }
  const send = await handleMarketingServiceRequest(new Request('https://api.mainbrella.com/api/send-marketing-email', {
    method: 'POST', headers: { Origin: origin }, body: '{}',
  }), env);
  assert.equal(send.status, 401);
  for (const path of ['/auth/me', '/containers', '/billing/balance', '/acquisition/link']) {
    for (const handler of [handleAdminServiceRequest, handleMarketingServiceRequest]) {
      assert.equal((await handler(new Request(`https://api.mainbrella.com${path}`), env)).status, 404);
    }
  }
  assert.equal((await handleAdminServiceRequest(new Request('https://api.mainbrella.com/api/send-marketing-email'), env)).status, 404);
  assert.equal((await handleMarketingServiceRequest(new Request('https://api.mainbrella.com/admin/users'), env)).status, 404);
});

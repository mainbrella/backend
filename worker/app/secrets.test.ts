import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from './router';
import { paidContainerFixture, SESSION_ONE, USER_ONE } from './paid-container-test-helpers';

const secretId = 'sec_d688d42a-25ef-4c13-9b28-21a0fde6e163';
test('secret management forwards only authenticated ownership and keeps revocation available during billing failure', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  const requests: Request[] = [];
  const env = { ...f.env, SECURITY_FEATURE_ACCOUNTS: '*', SECRETS_VAULT_ENABLED: 'true', CONTAINER_ACCOUNT: {
    idFromName(name: string) { assert.equal(name, `account:${USER_ONE}`); return name; }, get() { return { async fetch(request: Request) {
      requests.push(request); return Response.json({ secrets: [] });
    } }; },
  } } as unknown as Env;
  const call = (method = 'GET', path = '/secrets', body?: unknown, extra = {}) => handleRequest(new Request(`https://api.mainbrella.com${path}`, {
    method, headers: { Origin: 'https://mainbrella.com', Cookie: `mainbrella_session=${SESSION_ONE}`, 'x-mainbrella-user': 'victim', ...extra },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }), env);
  const body = { name: 'API', value: 'write-only', hostname: 'api.example.com', header: 'authorization', prefix: 'Bearer ' };
  assert.equal((await call('POST', '/secrets', body)).status, 200);
  assert.deepEqual(await requests[0].json(), body);
  assert.equal(requests[0].headers.get('x-mainbrella-user'), USER_ONE);
  assert.equal((await call('PUT', `/secrets/${secretId}`, { value: 'rotated' })).status, 200);
  assert.equal(new URL(requests[1].url).searchParams.get('secretId'), secretId);
  f.setBillingMode('failure');
  env.SECRETS_VAULT_ENABLED = 'false';
  const read = await call(); assert.equal(read.status, 200); assert.equal(read.headers.get('Cache-Control'), 'no-store');
  assert.equal((await call('DELETE', `/secrets/${secretId}`)).status, 200);
  assert.equal((await call('POST', '/secrets', body)).status, 503);
  assert.equal((await call('GET', '/secrets', undefined, { Authorization: 'Bearer invalid' })).status, 401);
  assert.equal((await call('GET', '/secrets?user=victim')).status, 400);
  assert.equal((await call('GET', `/secrets/${secretId}`)).status, 405);
  f.setBillingMode('paid'); env.SECRETS_VAULT_ENABLED = 'true'; env.SECURITY_FEATURE_ACCOUNTS = 'another-account';
  const count = requests.length;
  assert.equal((await call('POST', '/secrets', body)).status, 503);
  assert.equal((await call('PUT', `/secrets/${secretId}`, { value: 'rotation' })).status, 503);
  assert.equal(requests.length, count);
  assert.equal((await call('GET')).status, 200);
  assert.equal((await call('DELETE', `/secrets/${secretId}`)).status, 200);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from './router';
import { paidContainerFixture, SESSION_ONE, SESSION_TWO, USER_ONE } from './paid-container-test-helpers';

test('restricted creation normalizes allow/deny rules and fails closed before account admission', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  const forwarded: any[] = [];
  const env = { ...f.env, SECURITY_FEATURE_ACCOUNTS: '*', EGRESS_POLICIES_ENABLED: 'true', SECRETS_VAULT_ENABLED: 'true',
    EGRESS_RELAY_URL: 'https://relay.example.com/v1/egress', EGRESS_RELAY_TOKEN: 't'.repeat(64), SECRETS_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    CONTAINER_ACCOUNT: { idFromName(name: string) { return name; }, get() { return { async fetch(request: Request) {
      forwarded.push(await request.json()); return Response.json({ containers: [] });
    } }; } } } as unknown as Env;
  const secretId = 'sec_d688d42a-25ef-4c13-9b28-21a0fde6e163';
  const call = (body: unknown, target = env) => handleRequest(new Request('https://api.mainbrella.com/containers', {
    method: 'POST', headers: { Origin: 'https://mainbrella.com', Cookie: `mainbrella_session=${SESSION_ONE}`, 'Idempotency-Key': 'restricted' }, body: JSON.stringify(body),
  }), target);
  const selected = { networkPolicy: { allow: ['API.EXAMPLE.COM', '8.8.8.9/24'], deny: ['blocked.example.com'] }, secretBindings: [secretId] };
  assert.equal((await call(selected)).status, 200);
  assert.deepEqual(forwarded[0], { internet: false, networkPolicy: { allow: ['8.8.8.0/24', 'api.example.com'], deny: ['blocked.example.com'] }, secretBindings: [secretId] });
  for (const body of [
    { ...selected, internet: true }, { networkPolicy: { allow: ['https://api.example.com'] } },
    { networkPolicy: { allow: ['api.example.com'], enableInternet: true } }, { secretBindings: [secretId] },
    { ...selected, secretBindings: ['invalid'] },
  ]) assert.equal((await call(body)).status, 400);
  assert.equal((await call(selected, { ...env, EGRESS_POLICIES_ENABLED: 'false' })).status, 503);
  assert.equal((await call(selected, { ...env, EGRESS_RELAY_TOKEN: '' })).status, 503);
  assert.equal((await call(selected, { ...env, SECRETS_ENCRYPTION_KEY: '' })).status, 503);
  assert.equal((await call({ name: 'x'.repeat(65536) })).status, 413);
  assert.equal(forwarded.length, 1);
  const caps = await (await handleRequest(new Request('https://api.mainbrella.com/capabilities'), env)).json() as any;
  assert.equal(caps.networking.egressPolicies, true); assert.equal(caps.secrets.vault, true);
  const disabled = await (await handleRequest(new Request('https://api.mainbrella.com/capabilities'), { ...env, EGRESS_RELAY_TOKEN: '' })).json() as any;
  assert.equal(disabled.networking.egressPolicies, false); assert.equal(disabled.secrets.vault, false);
});
test('private security rollout exposes capabilities only to the authenticated allowed account', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  let admissions = 0;
  const env = { ...f.env, SECURITY_FEATURE_ACCOUNTS: USER_ONE, EGRESS_POLICIES_ENABLED: 'true', SECRETS_VAULT_ENABLED: 'true',
    EGRESS_RELAY_URL: 'https://relay.example.com/v1/egress', EGRESS_RELAY_TOKEN: 't'.repeat(64), SECRETS_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
    CONTAINER_ACCOUNT: { idFromName: (name: string) => name, get: () => ({ fetch: async () => { admissions++; return Response.json({ containers: [] }); } }) },
  } as unknown as Env;
  for (const [cookie, allowed, extra] of [[SESSION_ONE, true, {}], [SESSION_TWO, false, { 'x-mainbrella-user': USER_ONE }],
    ['', false, {}], [SESSION_ONE, false, { Authorization: 'Bearer invalid' }]] as const) {
    const response = await handleRequest(new Request('https://api.mainbrella.com/capabilities', { headers: { Cookie: `mainbrella_session=${cookie}`, ...extra } }), env);
    const caps = await response.json() as any;
    assert.equal(caps.networking.egressPolicies, allowed); assert.equal(caps.secrets.vault, allowed);
    assert.match(response.headers.get('Vary') ?? '', /Authorization/); assert.match(response.headers.get('Vary') ?? '', /Cookie/);
  }
  const denied = await handleRequest(new Request('https://api.mainbrella.com/containers', { method: 'POST', headers: {
    Origin: 'https://mainbrella.com', Cookie: `mainbrella_session=${SESSION_TWO}`, 'x-mainbrella-user': USER_ONE,
  }, body: JSON.stringify({ networkPolicy: { allow: ['api.example.com'] } }) }), env);
  assert.equal(denied.status, 503); assert.equal(admissions, 0);
});

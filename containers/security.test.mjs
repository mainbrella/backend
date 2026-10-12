import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountSecurity } from './account-security.js';
import { ContainerSecurity, relayContainerEgress } from './security-runtime.js';
import { UserContainerController } from './user-container-core.js';
import { normalizeNetworkPolicy, normalizeSecretBindings, publicAddress, targetAllowed, egressTarget } from './security-contract.js';

const now = Date.UTC(2026, 9, 11), createdAt = new Date(now).toISOString(), incarnation = '12345678-1234-1234-1234-123456789abc';
const entitlement = { active: true, plan: 'builder', checkedAt: now, validUntil: now + 86400000 };
const env = { SECURITY_FEATURE_ACCOUNTS: '*', EGRESS_POLICIES_ENABLED: 'true', SECRETS_VAULT_ENABLED: 'true', EGRESS_RELAY_URL: 'https://relay.example.com/v1/egress', EGRESS_RELAY_TOKEN: 't'.repeat(40), SECRETS_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64') };
class Storage {
  values = new Map();
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async delete(key) { this.values.delete(key); }
  async list({ prefix, limit }) { return new Map([...this.values].filter(([key]) => key.startsWith(prefix)).slice(0, limit)); }
  async setAlarm() {}
  async deleteAlarm() {}
}
function fixture() {
  const storage = new Storage(), calls = [];
  let generation = { networkPolicy: { allow: ['api.example.com'], deny: [] }, secretBindings: [], incarnation };
  storage.values.set('containerAccount', { userId: 'alice', entitlement });
  const account = { ctx: { storage }, now: () => now, serialized: async fn => fn(), respond: (value, status = 200) => Response.json(value, { status }), machineFor: () => ({ fetch: async () => generation ? Response.json(generation) : new Response(null, { status: 403 }) }) };
  const security = new AccountSecurity(account, { ...env }, async (url, options) => { calls.push({ url, options }); return Response.json({ version: 1, status: 200, headers: [['content-type', 'application/json']], body: Buffer.from('{"ok":true}').toString('base64') }); });
  const request = (method, body, id, user = 'alice') => security.fetch(new Request(`https://internal/secrets${id ? '?secretId=' + id : ''}`, { method, headers: { 'x-mainbrella-user': user, 'x-mainbrella-plan': 'builder', 'x-mainbrella-paid-until': String(entitlement.validUntil), 'x-mainbrella-entitlement-checked-at': String(now) }, ...(body ? { body: JSON.stringify(body) } : {}) }));
  const egress = () => security.fetch(new Request('https://internal/security/egress', { headers: { 'x-mainbrella-user': 'alice', 'x-egress-id': 'small', 'x-egress-generation': createdAt, 'x-egress-incarnation': incarnation, 'x-egress-url': 'https://api.example.com/v1', authorization: 'guest-value', 'x-egress-spoof': 'guest' } }));
  return { storage, security, request, calls, egress, setGeneration: value => { generation = value; } };
}
const secretInput = { name: 'Example API', value: 'private-value-12345', hostname: 'api.example.com', header: 'authorization', prefix: 'Bearer ' };

test('policy normalization is strict and deny rules override wildcard/subdomain/CIDR grants', () => {
  const policy = normalizeNetworkPolicy({ allow: ['*.Example.com', '93.184.216.200/24', '*.example.com'], deny: ['bad.example.com'] });
  assert.deepEqual(policy, { allow: ['*.example.com', '93.184.216.0/24'], deny: ['bad.example.com'] });
  assert.equal(targetAllowed(policy, 'good.example.com', '8.8.8.8'), true);
  assert.equal(targetAllowed(policy, 'bad.example.com', '93.184.216.34'), false);
  assert.equal(targetAllowed(policy, 'example.com', '8.8.8.8'), false);
  assert.equal(targetAllowed(policy, 'other.example.org', '93.184.216.34'), true);
  for (const value of [null, {}, { allow: ['api.example.com:443'] }, { allow: ['https://example.com'] }, { allow: ['127.0.0.1/99'] }, { allow: ['example.com'], spoof: true }, { allow: ['*.internal'] }]) assert.equal(normalizeNetworkPolicy(value), null);
  assert.equal(normalizeSecretBindings(['not-a-secret']), null);
});
test('public target checks reject private, special, mapped IPv6, URL credentials and alternate ports', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '100.64.1.1', '169.254.169.254', '172.16.1.1', '192.168.1.1', '198.18.0.1', '224.0.0.1', '::1', '::ffff:8.8.8.8', 'fc00::1', 'fe80::1', '2001:db8::1', '2002::1']) assert.equal(publicAddress(ip), false, ip);
  for (const ip of ['8.8.8.8', '2606:4700:4700::1111']) assert.equal(publicAddress(ip), true);
  for (const url of ['http://2130706433/', 'http://127.1/', 'https://[::1]/', 'https://user:pw@example.com', 'https://example.com:8443', 'https://example.com/#fragment', 'ftp://example.com/']) assert.equal(egressTarget(url), null, url);
});
test('vault stores authenticated ciphertext, returns metadata only and supports rotation/deletion without runtime', async () => {
  const f = fixture(), response = await f.request('POST', secretInput);
  assert.equal(response.status, 201); const metadata = await response.json();
  assert.match(metadata.id, /^sec_/); assert.equal(metadata.value, undefined);
  assert.equal(JSON.stringify([...f.storage.values]).includes(secretInput.value), false);
  const stored = await f.storage.get('vault:' + metadata.id);
  assert.equal(await f.security.decrypt('alice', stored), secretInput.value);
  await assert.rejects(() => f.security.decrypt('bob', stored));
  await assert.rejects(() => f.security.decrypt('alice', { ...stored, id: 'another' }));
  assert.deepEqual((await (await f.request('GET')).json()).secrets, [metadata]);
  assert.equal((await f.request('PUT', { value: 'rotated-secret-value' }, metadata.id)).status, 200);
  assert.equal(await f.security.decrypt('alice', await f.storage.get('vault:' + metadata.id)), 'rotated-secret-value');
  f.security.env.SECRETS_VAULT_ENABLED = 'false';
  assert.equal((await f.request('DELETE', null, metadata.id)).status, 200);
  assert.equal((await f.request('GET', null, metadata.id)).status, 404);
  assert.equal(f.calls.length, 0);
});
test('vault rejects cross-account access, unsupported headers and malformed values; disabled gate cannot write', async () => {
  const f = fixture();
  assert.equal((await f.request('GET', null, null, 'bob')).status, 403);
  for (const change of [{ header: 'host' }, { value: 'a\r\nb' }, { value: '' }, { hostname: '*.example.com' }, { prefix: '\n' }, { ciphertext: 'bad' }]) assert.equal((await f.request('POST', { ...secretInput, ...change })).status, 400);
  f.security.env.SECRETS_VAULT_ENABLED = 'false';
  assert.equal((await f.request('POST', secretInput)).status, 503);
});
test('binding validation requires available relay, owned secrets and unique immutable scopes', async () => {
  const f = fixture(), first = await (await f.request('POST', secretInput)).json(), second = await (await f.request('POST', secretInput)).json();
  const selection = { internet: false, networkPolicy: { allow: ['api.example.com'] }, secretBindings: [first.id] };
  assert.equal(await f.security.validateSelection({ userId: 'alice' }, selection), null);
  assert.equal(await f.security.validateSelection({ userId: 'bob' }, selection), 'secret_not_found');
  assert.equal(await f.security.validateSelection({ userId: 'alice' }, { ...selection, secretBindings: [first.id, second.id] }), 'secret_binding_conflict');
  delete f.security.env.EGRESS_RELAY_TOKEN;
  assert.equal(await f.security.validateSelection({ userId: 'alice' }, selection), 'network_policy_unavailable');
});
test('egress injects only in authenticated relay envelope and withholds stopped-generation responses', async () => {
  const f = fixture(), secret = await (await f.request('POST', secretInput)).json();
  f.setGeneration({ networkPolicy: { allow: ['api.example.com'], deny: [] }, secretBindings: [secret.id], incarnation });
  const response = await f.egress(); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true });
  const call = f.calls[0], envelope = JSON.parse(call.options.body);
  assert.equal(call.url, env.EGRESS_RELAY_URL); assert.equal(call.options.redirect, 'manual');
  assert.equal(call.options.headers.authorization, 'Bearer ' + env.EGRESS_RELAY_TOKEN);
  assert.deepEqual(envelope.injections, [{ header: 'authorization', prefix: 'Bearer ', value: secretInput.value }]);
  assert.equal(envelope.headers.some(([name]) => name.startsWith('x-egress-') || name.startsWith('x-mainbrella-')), false);
  f.security.fetcher = async () => { f.setGeneration(null); return Response.json({ version: 1, status: 200, headers: [], body: Buffer.from('late response').toString('base64') }); };
  assert.equal((await f.egress()).status, 403);
});
test('default relay fetch retains the global receiver required by Workers', async () => {
  const f = fixture(), original = globalThis.fetch;
  let calls = 0, security;
  globalThis.fetch = async function () {
    assert.equal(this, globalThis, 'Workers fetch rejects another receiver');
    calls++;
    return Response.json({ version: 1, status: 200, headers: [], body: Buffer.from('acknowledged').toString('base64') });
  };
  try { security = new AccountSecurity(f.security.account, { ...env }); }
  finally { globalThis.fetch = original; }
  const response = await security.fetch(new Request('https://internal/security/egress', { headers: {
    'x-mainbrella-user': 'alice', 'x-egress-id': 'small', 'x-egress-generation': createdAt,
    'x-egress-incarnation': incarnation, 'x-egress-url': 'https://api.example.com/v1',
  } }));
  assert.equal(response.status, 200); assert.equal(await response.text(), 'acknowledged'); assert.equal(calls, 1);
});
test('secret deletion or rotation during egress fences the old response and missing secrets block later requests', async () => {
  const f = fixture(), secret = await (await f.request('POST', secretInput)).json();
  f.setGeneration({ networkPolicy: { allow: ['api.example.com'], deny: [] }, secretBindings: [secret.id], incarnation });
  let calls = 0;
  f.security.fetcher = async () => { calls++; await f.request('DELETE', null, secret.id); return Response.json({ version: 1, status: 200, headers: [], body: '' }); };
  assert.equal((await f.egress()).status, 403);
  assert.equal((await f.egress()).status, 403); assert.equal(calls, 1);
});
test('provider recovery with the same logical createdAt still revokes requests from the old runtime incarnation', async () => {
  const f = fixture();
  f.security.fetcher = async () => { f.setGeneration({ networkPolicy: { allow: ['api.example.com'], deny: [] }, secretBindings: [], incarnation: crypto.randomUUID() }); return Response.json({ version: 1, status: 200, headers: [], body: '' }); };
  assert.equal((await f.egress()).status, 403);
  assert.equal(f.security.active, 0);
});
test('native interception precedes restricted boot and policy metadata contains only secret IDs', async () => {
  const storage = new Storage(), order = [];
  storage.values.set('activityOwner', { userId: 'alice', containerId: 'small' });
  const container = { images: { terminal: 'image@sha256:fake' }, running: false,
    async interceptAllOutboundHttp() { order.push('http'); }, async interceptOutboundHttps(host) { assert.equal(host, '*'); order.push('https'); },
    start(options) { order.push('start'); assert.equal(options.enableInternet, false); assert.match(options.env.NODE_EXTRA_CA_CERTS, /cloudflare-containers-ca\.crt$/); this.running = true; },
    async exec() { return { output: async () => ({ exitCode: 0 }) }; }, async setInactivityTimeout() {}, async destroy() { this.running = false; } };
  const controller = new UserContainerController({ storage, container }, () => now);
  controller.security = new ContainerSecurity(controller, env, props => { assert.deepEqual(Object.keys(props).sort(), ['createdAt', 'id', 'incarnation', 'userId']); return {}; });
  const response = await controller.fetch(new Request('https://internal/container/egress-v1', { method: 'POST', headers: { 'x-mainbrella-plan': 'builder', 'x-mainbrella-paid-until': String(entitlement.validUntil) }, body: JSON.stringify({ networkPolicy: { allow: ['api.example.com'] }, internet: false }) }));
  assert.equal(response.status, 200); assert.deepEqual(order, ['http', 'https', 'start']);
  assert.equal((await response.json()).containers[0].internet, false);
  const request = new Request('https://internal/security/status-v1', { headers: { 'x-egress-generation': createdAt, 'x-egress-incarnation': (await storage.get('builderMachine')).telemetryId } });
  assert.equal((await controller.security.status(request)).status, 200);
  await controller.destroy(); assert.equal((await controller.security.status(request)).status, 403);
});
test('runtime forwarded attestations replace guest spoofing and do not include secrets', async () => {
  let received;
  const environment = { SECURITY_FEATURE_ACCOUNTS: '*', CONTAINER_ACCOUNT: { idFromName: name => name, get: () => ({ fetch: async request => { received = request; return new Response('ok'); } }) } };
  await relayContainerEgress(new Request('https://api.example.com/v1', { headers: { 'x-egress-generation': 'spoof', 'x-mainbrella-user': 'bob' } }), environment, { userId: 'alice', id: 'small', createdAt, incarnation });
  assert.equal(received.headers.get('x-mainbrella-user'), 'alice'); assert.equal(received.headers.get('x-egress-generation'), createdAt);
  assert.equal(received.headers.get('x-egress-url'), 'https://api.example.com/v1');
});
test('account rollout denies admission and writes while preserving owned metadata and deletion', async () => {
  const f = fixture(), secret = await (await f.request('POST', secretInput)).json();
  f.security.env.SECURITY_FEATURE_ACCOUNTS = 'bob';
  assert.equal(await f.security.validateSelection({ userId: 'alice' }, { networkPolicy: { allow: ['api.example.com'] } }), 'network_policy_unavailable');
  assert.equal((await f.request('POST', secretInput)).status, 503);
  assert.equal((await f.request('PUT', { value: 'rotation' }, secret.id)).status, 503);
  assert.equal((await f.request('GET')).status, 200);
  assert.equal((await f.request('DELETE', null, secret.id)).status, 200);
  assert.equal((await f.egress()).status, 403); assert.equal(f.calls.length, 0);
});
test('withdrawal during a mediated request withholds its response', async () => {
  for (const field of ['SECURITY_FEATURE_ACCOUNTS', 'EGRESS_POLICIES_ENABLED', 'EGRESS_RELAY_TOKEN']) {
    const f = fixture();
    f.security.fetcher = async () => {
      f.security.env[field] = '';
      return Response.json({ version: 1, status: 200, headers: [], body: Buffer.from('late').toString('base64') });
    };
    assert.equal((await f.egress()).status, 403, field);
  }
});

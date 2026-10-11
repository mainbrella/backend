import test from 'node:test';
import assert from 'node:assert/strict';
import { Mainbrella } from './index.js';
import { normalizeNetworkPolicy } from './network-policy.js';
import { normalizeNetworkPolicy as serverPolicy } from '../../containers/security-contract.js';

const apiKey = `mb_${'a'.repeat(64)}`, createdAt = '2026-10-11T00:00:00.000Z';
const secret = 'sec_d688d42a-25ef-4c13-9b28-21a0fde6e163';
const reply = policy => ({ creation: { id: 'receipt', containerId: 'small', createdAt, status: 'running' },
  containers: [{ id: 'small', createdAt, status: 'running', internet: false, networkPolicy: policy, secretBindings: [secret] }] });

test('SDK canonical policy matches backend for domain variants and IPv4/IPv6 host bits', () => {
  for (const policy of [
    { allow: ['API.Example.COM', '*.Example.org', 'api.example.com'], deny: ['private.example.org'] },
    { allow: ['8.8.8.42/24', '2606:4700:4700::1111/32', '8.8.4.4', '[2606:4700::1]'] },
    { allow: ['::ffff:8.8.8.8/120', '*'], deny: ['2001:4860:4860:0000::8888/48'] },
    { allow: [], deny: ['*'] }, { allow: ['8.8.8.8/33'] }, { allow: ['host.local'] },
  ]) assert.deepEqual(normalizeNetworkPolicy(policy), serverPolicy(policy));
});

test('restricted creation rejects broader returned policy and lost deny rules', async () => {
  for (const returned of [{ allow: ['*'], deny: ['private.example.com'] }, { allow: ['*.example.com'], deny: [] }]) {
    const client = new Mainbrella({ apiKey, fetch: async url => Response.json(url.pathname === '/capabilities'
      ? { networking: { egressPolicies: true } } : reply(returned)) });
    await assert.rejects(client.create({ networkPolicy: { allow: ['*.example.com'], deny: ['private.example.com'] }, idempotencyKey: 'same-policy' }),
      { code: 'network_policy_unconfirmed', idempotencyKey: 'same-policy' });
  }
});

test('creation snapshots rules and secret IDs before discovery and retains canonical request through retries', async () => {
  const networkPolicy = { allow: ['8.8.8.42/24', 'API.Example.COM'], deny: ['private.example.com'] };
  const secretBindings = [secret], posts = [];
  const canonical = normalizeNetworkPolicy(networkPolicy);
  const client = new Mainbrella({ apiKey, fetch: async (url, options) => {
    if (url.pathname === '/capabilities') {
      networkPolicy.allow.splice(0, 2, '*'); networkPolicy.deny.length = 0; secretBindings.length = 0;
      return Response.json({ networking: { egressPolicies: true }, secrets: { vault: true } });
    }
    posts.push({ body: JSON.parse(options.body), key: options.headers['Idempotency-Key'] });
    if (posts.length === 1) return Response.json({ error: 'containers_unavailable' }, { status: 503 });
    return Response.json(reply(canonical));
  } });
  const sandbox = await client.create({ networkPolicy, secretBindings, idempotencyKey: 'stable-request', pollIntervalMs: 1 });
  assert.deepEqual(posts[0], posts[1]);
  assert.deepEqual(posts[0].body.networkPolicy, canonical);
  assert.deepEqual(posts[0].body.secretBindings, [secret]);
  assert.deepEqual(sandbox.networkPolicy, canonical);
});

test('resuming a known restricted machine rejects a broader restored policy', async () => {
  const resumedAt = '2026-10-11T00:01:00.000Z';
  const client = new Mainbrella({ apiKey, fetch: async url => {
    if (url.pathname === '/capabilities') return Response.json({ persistence: { filesystemAfterStop: true } });
    const data = reply({ allow: ['*'], deny: [] }); data.creation.createdAt = resumedAt; data.containers[0].createdAt = resumedAt;
    return Response.json(data);
  } });
  const source = client.connect({ id: 'small', createdAt, internet: false, networkPolicy: { allow: ['api.example.com'], deny: [] } });
  await assert.rejects(source.resume({ idempotencyKey: 'safe-resume' }), { code: 'network_policy_unconfirmed', idempotencyKey: 'safe-resume' });
});

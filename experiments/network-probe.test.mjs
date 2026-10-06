import test from 'node:test';
import assert from 'node:assert/strict';
import { relayRequest, relayUrl, probeNetwork, NETWORK_PROBE_DEADLINE_MS } from './network-probe.js';
const runId = 'd688d42a-25ef-4c13-9b28-21a0fde6e163';
const env = { NETWORK_PROBE_ENABLED: 'true', NETWORK_PROBE_RELAY_URL: 'https://relay.example.com/probe', NETWORK_PROBE_RELAY_TOKEN: 'secret-' + 'a'.repeat(32) };
const props = { runId, expiresAt: Date.now() + 60_000, mode: 'allow' };
function request(url = env.NETWORK_PROBE_RELAY_URL + '?runId=' + runId, options) { return new Request(url, options); }

test('isolated mediator rejects wrong destinations, stale/revoked identity and caller-controlled proxy fields', async () => {
  let calls = 0; const fetcher = async () => { calls++; throw new Error('must not forward'); };
  for (const url of ['http://relay.example.com/probe', 'https://evil.example.com/probe', 'https://relay.example.com/other',
    env.NETWORK_PROBE_RELAY_URL + '?runId=' + runId + '&next=https://evil.test', env.NETWORK_PROBE_RELAY_URL + '?runId=foreign']) {
    assert.equal((await relayRequest(request(url), env, props, fetcher)).status, 403);
  }
  assert.equal((await relayRequest(request(undefined, { method: 'POST', body: 'private' }), env, props, fetcher)).status, 403);
  for (const changes of [{ mode: 'deny' }, { expiresAt: 0 }, { expiresAt: Date.now() + NETWORK_PROBE_DEADLINE_MS + 1000 }, { runId: 'invalid' }]) {
    assert.equal((await relayRequest(request(), env, { ...props, ...changes }, fetcher)).status, 403);
  }
  for (const value of ['http://relay.example.com/', 'https://127.0.0.1/', 'https://[::1]/', 'https://user:pass@relay.example.com/', 'https://relay.example.com/#secret', 'https://relay.example.com/?token=secret']) assert.equal(relayUrl(value), null);
  assert.equal(calls, 0);
});

test('relay injection stays outside guest requests and receiver responses are reduced to a fixed acknowledgment', async () => {
  let calls = 0;
  const response = await relayRequest(request(undefined, { headers: { Authorization: 'guest', Cookie: 'guest', 'X-Secret': 'guest' } }), env, props, async (url, options) => {
    calls++; assert.equal(url.href, env.NETWORK_PROBE_RELAY_URL + '?runId=' + runId);
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    assert.deepEqual(options.headers, { Authorization: 'Bearer ' + env.NETWORK_PROBE_RELAY_TOKEN, Accept: 'application/json' });
    return Response.json({ authenticated: true, runId, reflectedToken: env.NETWORK_PROBE_RELAY_TOKEN }, { headers: { 'Set-Cookie': env.NETWORK_PROBE_RELAY_TOKEN } });
  });
  const value = await response.text(); assert.equal(calls, 1); assert.ok(!value.includes(env.NETWORK_PROBE_RELAY_TOKEN)); assert.equal(response.headers.get('Set-Cookie'), null);
  assert.deepEqual(JSON.parse(value), { allowed: true, authenticated: true, runId });
  const failed = await relayRequest(request(), env, props, async () => new Response('private'.repeat(1000)));
  assert.equal(failed.status, 502); assert.deepEqual(await failed.json(), { allowed: false, error: 'relay_unavailable' });
});

function fixture({ bypass = false, cleanupFails = false } = {}) {
  const values = new Map(), starts = [], intercepts = [], sources = []; let commands = 0, alarm;
  const ctx = { storage: { async get(key) { return values.get(key); }, async put(key, value) { values.set(key, structuredClone(value)); }, async setAlarm(value) { alarm = value; }, async deleteAlarm() { alarm = undefined; } },
    container: { images: { terminal: 'registry/image@sha256:local' }, running: false,
      async interceptAllOutboundHttp(binding) { intercepts.push(['http', binding]); }, async interceptOutboundHttps(target, binding) { assert.equal(target, '*'); intercepts.push(['https', binding]); },
      start(options) { starts.push(options); this.running = true; }, async setInactivityTimeout() {},
      async destroy() { if (cleanupFails) throw new Error('private provider failure'); this.running = false; },
      async exec(argv, options) { commands++; sources.push(argv[2]); assert.deepEqual(options.env, { NODE_EXTRA_CA_CERTS: '/etc/cloudflare/certs/cloudflare-containers-ca.crt' });
        const value = commands === 1 ? { status: 200, authenticated: true, runId: true } : commands === 2
          ? { httpDenied: true, httpsDenied: true, directIpDenied: !bypass, dnsTxtDenied: true } : { status: 403, authenticated: false };
        return { exitCode: Promise.resolve(0), async output() { return { exitCode: 0, stdout: JSON.stringify(value) }; }, kill() { throw new Error('already exited'); } };
      } } };
  return { ctx, values, starts, intercepts, sources, get alarm() { return alarm; } };
}

test('single-use native probe registers both protocols, revokes and records sanitized cleanup evidence', async () => {
  const f = fixture(), result = await probeNetwork(f.ctx, props => ({ props }), env, { enabled: true });
  assert.equal(result.ok, true); assert.equal(result.cleanup, 'completed'); assert.equal(f.alarm, undefined);
  assert.equal(f.starts.length, 1); assert.equal(f.starts[0].enableInternet, false);
  assert.deepEqual(f.intercepts.map(([protocol, binding]) => [protocol, binding.props.mode]), [['http', 'allow'], ['https', 'allow'], ['http', 'deny'], ['https', 'deny']]);
  assert.ok(!JSON.stringify(f.sources).includes(env.NETWORK_PROBE_RELAY_TOKEN)); assert.ok(!JSON.stringify(result).includes(env.NETWORK_PROBE_RELAY_TOKEN));
  assert.deepEqual(f.values.get('networkProbeResult'), result);
  await assert.rejects(probeNetwork(f.ctx, props => ({ props }), env, { enabled: true }), /probe_already_used/);
});

test('probe is opt-in and a bypass or cleanup failure cannot be reported as success', async () => {
  const f = fixture(); await assert.rejects(probeNetwork(f.ctx, () => ({}), env), /network_probe_not_configured/); assert.equal(f.starts.length, 0);
  const bypass = fixture({ bypass: true }); const result = await probeNetwork(bypass.ctx, () => ({}), env, { enabled: true });
  assert.equal(result.ok, false); assert.equal(result.error, 'network_checks_failed');
  const failed = fixture({ cleanupFails: true }); const failure = await probeNetwork(failed.ctx, () => ({}), env, { enabled: true });
  assert.equal(failure.ok, false); assert.equal(failure.cleanup, 'failed'); assert.ok(failed.alarm);
});

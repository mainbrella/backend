import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import http from 'node:http';
import { createRelay, forwardEnvelope, resolveTarget, pinnedRequest } from '../services/egress-relay.mjs';

const envelope = (changes = {}) => ({ version: 1, url: 'https://api.example.com/v1', method: 'POST', headers: [['authorization', 'guest'], ['accept-encoding', 'gzip']], body: Buffer.from('{"hello":true}').toString('base64'), policy: { allow: ['api.example.com'], deny: [] }, injections: [{ header: 'authorization', prefix: 'Bearer ', value: 'super-secret-key' }], ...changes });
const resolver = async () => [{ address: '93.184.216.34', family: 4 }];
function response(body = '{"ok":true}', headers = {}, statusCode = 200) { return Object.assign(Readable.from([Buffer.from(body)]), { headers, statusCode }); }

test('relay pins allowed DNS address, preserves TLS target and replaces guest authorization', async () => {
  let calls = 0;
  const result = await forwardEnvelope(envelope(), { resolver, transport: async (url, address, options, body) => {
    calls++; assert.equal(url.hostname, 'api.example.com'); assert.deepEqual(address, { address: '93.184.216.34', family: 4 });
    assert.equal(options.headers.authorization, 'Bearer super-secret-key'); assert.equal(options.headers['accept-encoding'], 'identity');
    assert.equal(body.toString(), '{"hello":true}'); return response();
  } });
  assert.equal(calls, 1); assert.equal(result.status, 200); assert.equal(Buffer.from(result.body, 'base64').toString(), '{"ok":true}');
});
test('mixed private DNS, denied IP and domain deny prevent any outbound transport', async () => {
  for (const records of [[{ address: '127.0.0.1', family: 4 }], [{ address: '93.184.216.34', family: 4 }, { address: '::1', family: 6 }], []]) await assert.rejects(() => forwardEnvelope(envelope(), { resolver: async () => records, transport: () => assert.fail('must not connect') }));
  for (const policy of [{ allow: ['api.example.com'], deny: ['93.184.216.0/24'] }, { allow: ['*'], deny: ['api.example.com'] }]) await assert.rejects(() => forwardEnvelope(envelope({ policy }), { resolver, transport: () => assert.fail('must not connect') }));
  assert.deepEqual(await resolveTarget(new URL('http://93.184.216.34'), { allow: ['93.184.216.0/24'], deny: [] }, resolver), { address: '93.184.216.34', family: 4 });
});
test('denied names and CIDR-only grants cannot use resolver queries to exfiltrate data', async () => {
  for (const policy of [{ allow: ['allowed.example.com'], deny: [] }, { allow: ['93.184.216.0/24'], deny: [] }, { allow: ['*'], deny: ['api.example.com'] }]) {
    await assert.rejects(() => forwardEnvelope(envelope({ policy }), { resolver: () => assert.fail('denied host must not reach DNS'), transport: () => assert.fail('must not connect') }));
  }
});
test('relay blocks redirects, compressed bodies, unsafe protocols and literal/encoded credential reflection', async () => {
  for (const makeResponse of [() => response('', { location: 'https://evil.example.com' }, 302), () => response('compressed', { 'content-encoding': 'gzip' }),
    () => response('super-secret-key'), () => response(Buffer.from('super-secret-key').toString('base64')), () => response('ok', { 'x-reflected': 'Bearer super-secret-key' })]) {
    await assert.rejects(() => forwardEnvelope(envelope(), { resolver, transport: async () => makeResponse() }));
  }
  for (const url of ['http://api.example.com/v1', 'https://api.example.com:8443/', 'https://localhost/', 'http://169.254.169.254/']) await assert.rejects(() => forwardEnvelope(envelope({ url }), { resolver, transport: () => assert.fail('must not connect') }));
});
test('relay bounds response bodies before returning guest data', async () => {
  await assert.rejects(() => forwardEnvelope(envelope(), { resolver, transport: async () => response('x'.repeat(8 * 1024 * 1024 + 1)) }));
});
test('canceling a hanging DNS lookup releases the request without connecting later', async () => {
  const abort = new AbortController(); let resolved;
  const pending = forwardEnvelope(envelope(), { resolver: () => new Promise(resolve => { resolved = resolve; }), signal: abort.signal, transport: () => assert.fail('must not connect') });
  abort.abort(); await assert.rejects(pending);
  resolved([{ address: '93.184.216.34', family: 4 }]);
  await new Promise(resolve => setImmediate(resolve));
});
test('runnable relay authenticates exact endpoint and serves no unauthenticated upstream traffic', async () => {
  let calls = 0; const token = 't'.repeat(40);
  const server = createRelay({ token, resolver, transport: async () => { calls++; return response(); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/v1/egress`;
    assert.equal((await fetch(url, { method: 'POST', body: JSON.stringify(envelope()) })).status, 403);
    assert.equal((await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(envelope()) })).status, 200);
    assert.equal(calls, 1);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
test('real Node transport connects to the pinned address while retaining the original Host', async () => {
  let host;
  const server = http.createServer((request, response) => { host = request.headers.host; response.end('pinned'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    // Exercise the transport directly. The policy layer rejects loopback and
    // alternate ports; this local fixture supplies its own already-checked IP.
    const target = new URL(`http://does-not-resolve.invalid:${server.address().port}/`);
    const response = await pinnedRequest(target, { address: '127.0.0.1', family: 4 }, { method: 'GET', headers: {} }, Buffer.alloc(0), AbortSignal.timeout(2000));
    const chunks = []; for await (const chunk of response) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), 'pinned'); assert.equal(host, target.host);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

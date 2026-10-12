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

async function tlsFixture(t) {
  const { mkdtemp, readFile, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const https = await import('node:https');
  const directory = await mkdtemp(join(tmpdir(), 'mainbrella-egress-tls-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = name => join(directory, name);
  const openssl = args => execFileSync('openssl', args, { stdio: 'ignore', timeout: 10_000 });
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', file('ca.key'), '-out', file('ca.pem'),
    '-days', '1', '-subj', '/CN=Mainbrella local relay qualification CA']);
  openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', file('server.key'), '-out', file('server.csr'),
    '-subj', '/CN=api.example.com']);
  await writeFile(file('extensions'), 'basicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:api.example.com\n');
  openssl(['x509', '-req', '-in', file('server.csr'), '-CA', file('ca.pem'), '-CAkey', file('ca.key'), '-CAcreateserial',
    '-out', file('server.pem'), '-days', '1', '-extfile', file('extensions')]);
  let handler = (_request, response) => response.end('accepted');
  const requests = [];
  const server = https.createServer({ key: await readFile(file('server.key')), cert: await readFile(file('server.pem')) }, async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    requests.push({ host: request.headers.host, servername: request.socket.servername, headers: request.headers, body: Buffer.concat(chunks) });
    handler(request, response);
  });
  server.on('tlsClientError', () => {}); // Rejected certificates are expected test traffic.
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const port = server.address().port, ca = await readFile(file('ca.pem'));
  const address = { address: '127.0.0.1', family: 4 };
  // The real TLS socket always terminates on this local fixture. Policy DNS
  // remains separately checked; this adapter does not qualify public routing.
  const transport = (target, checkedAddress, options, bytes, signal) => {
    assert.deepEqual(checkedAddress, { address: '93.184.216.34', family: 4 });
    const localTarget = new URL(target); localTarget.port = String(port);
    return pinnedRequest(localTarget, address, { ...options, ca }, bytes, signal);
  };
  return { requests, port, ca, address, transport, respond: value => { handler = value; } };
}

test('real TLS transport verifies trust and original hostname, retaining SNI and Host at its pinned address', async t => {
  const fixture = await tlsFixture(t);
  const target = new URL(`https://api.example.com:${fixture.port}/`);
  const options = { method: 'POST', headers: { authorization: 'local-synthetic-credential' } };
  await assert.rejects(pinnedRequest(target, fixture.address, options, Buffer.from('private'), AbortSignal.timeout(2000)),
    error => ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'SELF_SIGNED_CERT_IN_CHAIN'].includes(error.code));
  const wrongHost = new URL(target); wrongHost.hostname = 'wrong.example.com';
  await assert.rejects(pinnedRequest(wrongHost, fixture.address, { ...options, ca: fixture.ca }, Buffer.from('private'), AbortSignal.timeout(2000)),
    { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
  assert.equal(fixture.requests.length, 0, 'TLS failures must prevent sending HTTP credentials or bodies');
  const incoming = await pinnedRequest(target, fixture.address, { ...options, ca: fixture.ca }, Buffer.from('private'), AbortSignal.timeout(2000));
  for await (const _chunk of incoming) {} // Consume the real response before cleanup.
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0].host, target.host);
  assert.equal(fixture.requests[0].servername, target.hostname);
  assert.equal(fixture.requests[0].body.toString(), 'private');
});

test('authenticated local relay performs real TLS injection and rejects adversarial upstream responses', async t => {
  const fixture = await tlsFixture(t), token = 'local-test-relay-token-'.repeat(2);
  const server = createRelay({ token, resolver, transport: fixture.transport });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/v1/egress`;
  const send = (body = envelope(), authorization = `Bearer ${token}`, target = url) => fetch(target, {
    method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  });
  for (const [authorization, target] of [['wrong', url], [`Bearer ${token}`, url + '/'], [`Bearer ${token}`, url + '?bypass=1']]) {
    assert.equal((await send(envelope(), authorization, target)).status, 403);
  }
  assert.equal(fixture.requests.length, 0);
  fixture.respond((_request, response) => {
    response.setHeader('set-cookie', 'upstream-private-cookie=ignored');
    response.end('{"authenticated":true}');
  });
  const allowed = await send(), value = await allowed.json();
  assert.equal(allowed.status, 200); assert.equal(value.status, 200);
  assert.equal(fixture.requests[0].headers.authorization, 'Bearer super-secret-key');
  assert.equal(fixture.requests[0].headers['accept-encoding'], 'identity');
  assert.equal(fixture.requests[0].servername, 'api.example.com');
  assert.equal(fixture.requests[0].body.toString(), '{"hello":true}');
  assert.equal(value.headers.some(([name]) => name === 'set-cookie'), false);
  assert.equal(JSON.stringify(value).includes('super-secret-key'), false);
  const adversaries = [
    (_request, response) => { response.writeHead(302, { location: 'https://evil.example.com/' }); response.end('redirect'); },
    (_request, response) => { response.setHeader('content-encoding', 'gzip'); response.end('compressed'); },
    (_request, response) => response.end('super-secret-key'),
    (_request, response) => response.end(Buffer.from('super-secret-key').toString('base64')),
    (_request, response) => { response.setHeader('x-reflected', 'Bearer super-secret-key'); response.end('body'); },
    (_request, response) => response.end(Buffer.alloc(8 * 1024 * 1024 + 1)),
  ];
  for (const handler of adversaries) {
    fixture.respond(handler);
    const denied = await send();
    assert.equal(denied.status, 403); assert.deepEqual(await denied.json(), { error: 'egress_denied' });
  }
  assert.equal(fixture.requests.length, adversaries.length + 1, 'redirects must never trigger a second upstream request');
});

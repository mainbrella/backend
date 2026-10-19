import test from 'node:test';
import assert from 'node:assert/strict';
import { Response as MfResponse } from 'miniflare';
import { BffError } from './contracts';
import { FETCH_LIMITS, fetchInput, fetchUrl } from './fetch';
import { runtime } from './system-test-helpers';

const input = fetchInput.parse({ url: 'https://example.com/page', userAgent: 'My Preview Client/2.0' });
const failure = (code: string, status: number) => (error: unknown) => error instanceof BffError && error.code === code && error.status === status;

test('BFF fetch sends the custom User-Agent and returns upstream replies without forwarding credentials or applying upstream headers', async t => {
  const calls: { url: string; headers: Headers }[] = [];
  const f = await runtime(t, {}, async request => {
    calls.push({ url: request.url, headers: new Headers([...request.headers]) });
    return new MfResponse('<html>upstream reply</html>', { status: 418, statusText: 'Teapot', headers: {
      'content-type': 'text/html', 'set-cookie': 'untrusted=value; Domain=mainbrella.com', 'x-upstream': 'present',
      'access-control-allow-origin': 'https://evil.com',
    } });
  });
  const response = await f.request('/fetch', 'POST', input, 'owner', { 'x-caller-secret': 'do-not-forward' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://mainbrella.com');
  assert.equal(response.headers.get('set-cookie'), null);
  const reply = await response.json() as any;
  assert.equal(reply.status, 418); assert.equal(reply.statusText, 'Teapot'); assert.equal(reply.ok, false);
  assert.equal(reply.body, '<html>upstream reply</html>'); assert.equal(reply.bodyEncoding, 'text');
  assert.equal(reply.headers['x-upstream'], 'present'); assert.equal(reply.redirected, false);
  assert.equal(calls[0].headers.get('user-agent'), input.userAgent);
  for (const header of ['cookie', 'authorization', 'origin', 'x-caller-secret']) assert.equal(calls[0].headers.get(header), null, header);

  const created = await f.mf.dispatchFetch('https://api.mainbrella.com/api-keys', { method: 'POST',
    headers: { cookie: 'mainbrella_session=owner', origin: 'https://mainbrella.com' }, body: JSON.stringify({ name: 'Fetch client' }) });
  const { token } = await created.json() as any;
  for (const [path, body] of [['/fetch', input], ['/og-image', { url: input.url }]] as const) {
    const before = calls.length;
    for (const authorization of ['Bearer invalid', `Bearer mb_${'0'.repeat(64)}`, `Bearer bff_pk_${'a'.repeat(64)}`]) {
      assert.equal((await f.request(path, 'POST', body, 'owner', { authorization })).status, 401);
    }
    assert.equal((await f.request(path, 'POST', body, 'missing')).status, 401);
    assert.equal((await f.request(path, 'POST', body, 'owner', { origin: 'https://evil.com' })).status, 403);
    assert.equal((await f.request(path)).status, 405);
    const preflight = await f.request(path, 'OPTIONS');
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');
    assert.equal(calls.length, before, 'Rejected calls and preflight never fetch upstream');
    const authorized = await f.mf.dispatchFetch(`https://api.mainbrella.com/bff${path}`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(authorized.status, path === '/fetch' ? 200 : 502);
    assert.equal(calls.at(-1)!.headers.get('authorization'), null);
  }
});

test('fetch services honor BFF disablement and validate JSON before network access', async t => {
  let calls = 0;
  const f = await runtime(t, { BFF_ENABLED: 'false' }, async () => { calls++; return new MfResponse('unexpected'); });
  for (const path of ['/fetch', '/og-image']) assert.equal((await f.request(path, 'POST', input)).status, 503);
  assert.equal(calls, 0);
  const active = await runtime(t, {}, async () => { calls++; return new MfResponse('unexpected'); });
  assert.equal((await active.request('/fetch', 'POST', { url: input.url })).status, 400);
  assert.equal((await active.request('/og-image', 'POST', { url: 'http://127.1/' })).status, 400);
  assert.equal((await active.request('/fetch', 'POST', input, 'owner', { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await active.request('/fetch', 'POST', { ...input, extra: 'x'.repeat(FETCH_LIMITS.requestBytes) })).status, 413);
  assert.equal(calls, 0);
});

test('fetch validation rejects unsafe URLs, header injection, unsupported options and invalid body encodings', () => {
  for (const url of ['file:///etc/passwd', 'ftp://example.com/', 'https://user:pass@example.com/', 'http://localhost/',
    'http://foo.internal/', 'http://127.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://10.0.0.1/',
    'http://169.254.169.254/', 'https://[::1]/', 'https://[::ffff:127.0.0.1]/', 'https://example.com:8443/', 'bad']) {
    assert.equal(fetchInput.safeParse({ ...input, url }).success, false, url);
  }
  for (const userAgent of ['', '   ', 'bot\r\nAuthorization: secret', 'bot\0', 'x'.repeat(1025), '🤖']) {
    assert.equal(fetchInput.safeParse({ ...input, userAgent }).success, false);
  }
  assert.equal(fetchInput.safeParse({ ...input, headers: {} }).success, false);
  assert.equal(fetchInput.safeParse({ ...input, responseType: 'json' }).success, false);
});

test('fetch follows validated redirects with the same User-Agent and preserves binary replies', async () => {
  const calls: string[] = [];
  const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(url));
    assert.equal(init?.redirect, 'manual'); assert.equal(init?.credentials, 'omit'); assert.equal(init?.cache, 'no-store');
    assert.equal(new Headers(init?.headers).get('user-agent'), input.userAgent);
    return calls.length === 1 ? new Response(null, { status: 302, headers: { location: '/final' } })
      : new Response(new Uint8Array([0, 128, 255]), { headers: { 'content-type': 'application/octet-stream' } });
  }) as typeof fetch;
  const result = await fetchUrl({ ...input, responseType: 'base64' }, undefined, fetcher);
  assert.deepEqual(calls, ['https://example.com/page', 'https://example.com/final']);
  assert.equal(result.url, calls[1]); assert.equal(result.redirected, true);
  assert.equal(result.body, 'AID/'); assert.equal(result.bodyEncoding, 'base64');
  const empty = await fetchUrl(input, undefined, (async () => new Response(null, { status: 204 })) as typeof fetch);
  assert.equal(empty.status, 204); assert.equal(empty.body, '');
});

test('fetch rejects forbidden or malformed redirects and bounds redirect loops', async () => {
  for (const location of ['http://127.0.0.1/', 'http://metadata.internal/', 'file:///etc/passwd', 'https://user:pass@example.com/', 'http://[invalid']) {
    let calls = 0;
    await assert.rejects(fetchUrl(input, undefined, (async () => {
      calls++; return new Response(null, { status: 302, headers: { location } });
    }) as typeof fetch), failure('upstream_redirect_not_allowed', 502));
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(fetchUrl(input, undefined, (async () => {
    calls++; return new Response(null, { status: 307, headers: { location: '/loop' } });
  }) as typeof fetch), failure('too_many_redirects', 502));
  assert.equal(calls, FETCH_LIMITS.redirects + 1);
});

test('fetch limits streamed bytes even without Content-Length and cancels oversized responses', async () => {
  let canceled = false;
  await assert.rejects(fetchUrl(input, undefined, (async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(FETCH_LIMITS.responseBytes + 1)); },
    cancel() { canceled = true; },
  }))) as typeof fetch), failure('response_too_large', 413));
  assert.equal(canceled, true);
});

test('fetch reports network and body failures as 502 and enforces its deadline while reading a stalled body', async t => {
  await assert.rejects(fetchUrl(input, undefined, (async () => { throw new Error('private network diagnostics'); }) as typeof fetch), failure('fetch_failed', 502));
  await assert.rejects(fetchUrl(input, undefined, (async () => new Response(new ReadableStream({
    start(controller) { controller.error(new Error('broken upstream stream')); },
  }))) as typeof fetch), failure('fetch_failed', 502));
  const timeout = new AbortController(); let canceled = false;
  t.mock.method(AbortSignal, 'timeout', () => timeout.signal);
  const pending = fetchUrl(input, undefined, (async () => new Response(new ReadableStream({
    pull() { timeout.abort(new DOMException('Timed out', 'TimeoutError')); },
    cancel() { canceled = true; },
  }))) as typeof fetch);
  await assert.rejects(pending, failure('fetch_timeout', 504));
  assert.equal(canceled, true);
  const caller = new AbortController(); caller.abort();
  await assert.rejects(fetchUrl(input, caller.signal), failure('fetch_aborted', 408));
});

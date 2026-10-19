import test from 'node:test';
import assert from 'node:assert/strict';
import { Response as MfResponse } from 'miniflare';
import { FETCH_LIMITS } from './fetch';
import { runtime } from './system-test-helpers';

test('preview images use the bot headers, prefer the first Open Graph image and resolve URLs after redirects', async t => {
  const calls: string[] = [];
  const f = await runtime(t, {}, async request => {
    calls.push(request.url);
    assert.equal(request.headers.get('user-agent'), 'MainbrellaPreviewBot/1.0');
    assert.equal(request.headers.get('accept'), 'text/html');
    assert.equal(request.headers.get('cookie'), null); assert.equal(request.headers.get('authorization'), null);
    if (new URL(request.url).pathname === '/start') return new MfResponse(null, { status: 302, headers: { location: 'https://www.example.com/articles/page' } });
    return new MfResponse(`<html><head>
      <meta name="twitter:image" content="https://images.example.com/twitter.jpg">
      <meta PROPERTY="OG:IMAGE" content="../assets/first.jpg?a=1&amp;b=2">
      <meta property="og:image" content="https://images.example.com/second.jpg">
      </head><body>page</body></html>`, { headers: { 'content-type': 'text/html' } });
  });
  const reply = await f.json('/og-image', 'POST', { url: 'https://example.com/start' });
  assert.deepEqual(reply, { image: 'https://www.example.com/assets/first.jpg?a=1&b=2' });
  assert.deepEqual(calls, ['https://example.com/start', 'https://www.example.com/articles/page']);
});

test('preview images handle fallback, missing, unsafe, malformed and body-only metadata', async t => {
  const cases = [
    ['<meta name="twitter:image" content="//images.example.com/twitter.png">', 'https://images.example.com/twitter.png'],
    ['<meta property="og:image" content=""><meta name="twitter:image" content="/fallback.jpg">', 'https://example.com/fallback.jpg'],
    ['<meta property="og:image" content="/image.jpg?a=1&#38;b=2&#x26;c=3">', 'https://example.com/image.jpg?a=1&b=2&c=3'],
    ['<meta property="og:image" content="javascript:alert(1)"><meta name="twitter:image" content="/safe.jpg">', 'https://example.com/safe.jpg'],
    ['<meta property="og:image" content="http://[invalid">', null],
    ['<meta property="og:image" content="data:image/png;base64,AAAA">', null],
    ['<meta property="og:image" content="https://user:pass@example.com/private.jpg">', null],
    ['', null],
  ] as const;
  let html = '';
  const f = await runtime(t, {}, async () => new MfResponse(html, { headers: { 'content-type': 'text/html' } }));
  for (const [head, image] of cases) {
    html = `<html><head>${head}</head><body><meta property="og:image" content="/body-image.jpg"></body></html>`;
    assert.deepEqual(await f.json('/og-image', 'POST', { url: 'https://example.com/page' }), { image });
  }
  html = '<html><head><meta name="twitter:image" content="/incomplete.jpg">';
  assert.deepEqual(await f.json('/og-image', 'POST', { url: 'https://example.com/page' }), { image: 'https://example.com/incomplete.jpg' });
});

test('preview image fetching returns useful errors for HTTP failures, invalid redirects and oversized HTML', async t => {
  const f = await runtime(t, {}, async request => {
    const path = new URL(request.url).pathname;
    if (path === '/missing') return new MfResponse('missing', { status: 404 });
    if (path === '/redirect') return new MfResponse(null, { status: 302, headers: { location: 'http://127.0.0.1/' } });
    return new MfResponse('<html><head>' + ' '.repeat(FETCH_LIMITS.responseBytes) + '</head></html>', { headers: { 'content-type': 'text/html' } });
  });
  for (const [path, status, error] of [['missing', 502, 'upstream_http_404'], ['redirect', 502, 'upstream_redirect_not_allowed'], ['huge', 413, 'response_too_large']] as const) {
    assert.deepEqual(await f.json('/og-image', 'POST', { url: `https://example.com/${path}` }, status), { error });
  }
});

test('preview image parsing stops before a stalled page body and times out a stalled head', async t => {
  const encoder = new TextEncoder();
  const f = await runtime(t, {}, async request => {
    const path = new URL(request.url).pathname;
    return new MfResponse(new ReadableStream({
      start(controller) {
        if (path === '/og') controller.enqueue(encoder.encode('<html><head><meta property="og:image" content="/early.jpg">' + ' '.repeat(65_536)));
        if (path === '/body') controller.enqueue(encoder.encode('<html><head><meta name="twitter:image" content="/twitter.jpg"></head><body>' + ' '.repeat(65_536)));
        // Deliberately leave the stream open with no further bytes.
      },
    }), { headers: { 'content-type': 'text/html' } });
  });
  const started = Date.now();
  assert.deepEqual(await f.json('/og-image', 'POST', { url: 'https://example.com/og' }), { image: 'https://example.com/early.jpg' });
  assert.deepEqual(await f.json('/og-image', 'POST', { url: 'https://example.com/body' }), { image: 'https://example.com/twitter.jpg' });
  assert.ok(Date.now() - started < 8000, 'Metadata is returned without waiting for the upstream body to finish');
  assert.deepEqual(await f.json('/og-image', 'POST', { url: 'https://example.com/stalled' }, 504), { error: 'fetch_timeout' });
});

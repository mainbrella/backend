import test from 'node:test';
import assert from 'node:assert/strict';
import { Response as MfResponse } from 'miniflare';
import { newApiKey } from '../app/api-keys';
import { checksum } from './contracts';
import { FETCH_LIMITS } from './fetch';
import { runtime } from './system-test-helpers';

async function projectCredentials(f: Awaited<ReturnType<typeof runtime>>, origin = 'https://yapern.com') {
  const projectId = crypto.randomUUID(), sessionId = crypto.randomUUID();
  const { token: key, tokenHash, key: record } = await newApiKey('Preview client', 'bff');
  const token = `bff_us_${'a'.repeat(32)}${crypto.randomUUID().replaceAll('-', '')}`;
  await f.db.prepare("INSERT INTO bff_projects(id,user_id,name,state,created_at) VALUES(?,'owner',?,'ready',?)")
    .bind(projectId, projectId, record.created_at).run();
  await f.db.prepare("INSERT INTO api_keys(id,user_id,name,token_hash,prefix,created_at) VALUES(?,'owner',?,?,?,?)")
    .bind(record.id, record.name, tokenHash, record.prefix, record.created_at).run();
  await f.db.prepare("INSERT INTO bff_api_key_grants(api_key_id,project_id,origins,tables,functions) VALUES(?,?,?,'{}','{}')")
    .bind(record.id, projectId, JSON.stringify([origin])).run();
  await f.db.prepare('INSERT INTO bff_user_sessions(id,project_id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?,?)')
    .bind(sessionId, projectId, 'project-user', await checksum(token), '2099-01-01', record.created_at).run();
  return { projectId, sessionId, keyId: record.id, key, token,
    headers: { origin, cookie: '', apikey: key, authorization: `Bearer ${token}` } };
}

test('project users can request preview images with their scoped key and session, without forwarding credentials', async t => {
  let calls = 0;
  const f = await runtime(t, {}, async request => {
    calls++;
    for (const header of ['apikey', 'authorization', 'cookie', 'origin']) assert.equal(request.headers.get(header), null, header);
    return new MfResponse('<head><meta property="og:image" content="/preview.jpg"></head>');
  });
  const credentials = await projectCredentials(f);
  const response = await f.request('/og-image', 'POST', { url: 'https://example.com/page' }, 'missing', credentials.headers);
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { image: 'https://example.com/preview.jpg' });
  assert.equal(response.headers.get('access-control-allow-origin'), credentials.headers.origin);
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('vary'), 'Origin');
  assert.ok((await f.db.prepare('SELECT last_used_at FROM api_keys WHERE id=?').bind(credentials.keyId).first())?.last_used_at);
  // A project login does not grant access to the general-purpose fetch service.
  assert.equal((await f.request('/fetch', 'POST', { url: 'https://example.com', userAgent: 'Yapern/1.0' }, 'owner', {
    ...credentials.headers, origin: 'https://mainbrella.com',
  })).status, 401);
  assert.equal((await f.request('/og-image', 'POST', { url: 'http://127.1/' }, 'missing', credentials.headers)).status, 400);
  assert.equal((await f.request('/og-image', 'POST', { url: 'https://example.com' }, 'missing', {
    ...credentials.headers, 'content-type': 'text/plain',
  })).status, 415);
  assert.equal(calls, 1);
});

test('scoped preview callers cannot select another project or poll its screenshot jobs', async t => {
  let fetched = 0;
  const f = await runtime(t, {}, async () => { fetched++; return new MfResponse('<head><meta property="og:image" content="/og.jpg"></head>'); });
  const first = await projectCredentials(f), other = await projectCredentials(f);
  const wrong = await f.request('/og-image', 'POST', { url: 'https://example.com/', projectId: other.projectId }, 'missing', first.headers);
  assert.equal(wrong.status, 403); assert.equal(fetched, 0);
  const own = await f.request('/og-image', 'POST', { url: 'https://example.com/', projectId: first.projectId }, 'missing', first.headers);
  assert.equal(own.status, 200);
  assert.deepEqual(await own.json(), { image: 'https://example.com/og.jpg', source: 'og', status: 'ready' });
  const id = crypto.randomUUID();
  await f.db.prepare(`INSERT INTO bff_previews(id,project_id,user_id,url_hash,url,state,lease_until,expires_at,created_at)
    VALUES(?,?,'owner','hash','https://example.com/','pending',?,?,?)`)
    .bind(id, first.projectId, Date.now() + 120_000, Date.now() + 600_000, Date.now()).run();
  const path = `/projects/${first.projectId}/previews/${id}`;
  const status = await f.request(path, 'GET', undefined, 'missing', first.headers);
  assert.equal(status.status, 202);
  assert.equal(status.headers.get('access-control-allow-origin'), first.headers.origin);
  assert.equal((await f.request(path, 'GET', undefined, 'missing', other.headers)).status, 403);
  await f.db.prepare('DELETE FROM bff_user_sessions WHERE id=?').bind(first.sessionId).run();
  assert.equal((await f.request(path, 'GET', undefined, 'owner', first.headers)).status, 401);
});

test('project preview images honor BFF disablement before fetching', async t => {
  let calls = 0;
  const f = await runtime(t, { BFF_ENABLED: 'false' }, async () => { calls++; return new MfResponse('unexpected'); });
  const credentials = await projectCredentials(f);
  const response = await f.request('/og-image', 'POST', { url: 'https://example.com' }, 'missing', credentials.headers);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'bff_unavailable' });
  assert.equal(calls, 0);
});

test('preview image project auth rejects missing, invalid, expired, revoked and mismatched credentials before fetching', async t => {
  let calls = 0;
  const f = await runtime(t, {}, async () => { calls++; return new MfResponse('unexpected'); });
  const first = await projectCredentials(f), second = await projectCredentials(f, 'https://another-app.com');
  const input = { url: 'https://example.com/page' };
  const rejected = async (headers: Record<string, string>, status = 401, error = 'unauthorized') => {
    // Even an owner cookie must not rescue explicit invalid project credentials.
    const response = await f.request('/og-image', 'POST', input, 'owner', { ...first.headers, cookie: 'mainbrella_session=owner', ...headers });
    assert.equal(response.status, status, await response.clone().text());
    assert.deepEqual(await response.json(), { error });
  };
  await rejected({ authorization: '' });
  await rejected({ authorization: 'Bearer invalid' });
  await rejected({ authorization: `Bearer bff_us_${'0'.repeat(64)}` });
  await rejected({ apikey: '' });
  await rejected({ apikey: `bff_pk_${'0'.repeat(64)}` });
  await rejected({ authorization: `Bearer ${second.token}` });
  await rejected({ origin: 'https://another-app.com' }, 403, 'origin_not_allowed');
  // A permitted preflight for another live key never widens this key's origins.
  await rejected({ origin: 'https://mainbrella.com' }, 403, 'origin_not_allowed');
  for (const [update, status, error] of [
    ["state='pending'", 409, 'database_not_ready'], ["suspended=1", 403, 'project_paused'], ["blocked=1", 403, 'project_blocked'],
  ] as const) {
    await f.db.prepare(`UPDATE bff_projects SET ${update} WHERE id=?`).bind(first.projectId).run();
    await rejected({}, status, error);
    await f.db.prepare("UPDATE bff_projects SET state='ready',suspended=0,blocked=0 WHERE id=?").bind(first.projectId).run();
  }
  await f.db.prepare("UPDATE bff_user_sessions SET expires_at='2000-01-01' WHERE id=?").bind(first.sessionId).run();
  await rejected({});
  await f.db.prepare("UPDATE bff_user_sessions SET expires_at='2099-01-01' WHERE id=?").bind(first.sessionId).run();
  await f.db.prepare("UPDATE api_keys SET user_id='stranger' WHERE id=?").bind(first.keyId).run();
  await rejected({});
  await f.db.prepare("UPDATE api_keys SET user_id='owner' WHERE id=?").bind(first.keyId).run();
  await f.json(`/projects/${first.projectId}/sessions/${first.sessionId}`, 'DELETE');
  await rejected({});
  await f.json(`/projects/${second.projectId}/api-keys/${second.keyId}`, 'DELETE');
  await rejected(second.headers);
  assert.equal(calls, 0);
});

test('preview image preflights allow live scoped-key origins and reject unknown origins, methods and headers', async t => {
  const f = await runtime(t);
  const credentials = await projectCredentials(f);
  const preflight = (headers: Record<string, string> = {}) => f.mf.dispatchFetch('https://api.mainbrella.com/bff/og-image', {
    method: 'OPTIONS', headers: { origin: credentials.headers.origin, 'access-control-request-method': 'POST',
      'access-control-request-headers': 'apikey, authorization, content-type', ...headers },
  });
  const response = await preflight();
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), credentials.headers.origin);
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
  assert.equal(response.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
  assert.match(response.headers.get('access-control-allow-headers')!, /apikey/);
  const owner = await preflight({ origin: 'https://mainbrella.com', 'access-control-request-headers': 'content-type, idempotency-key' });
  assert.equal(owner.status, 204);
  assert.equal(owner.headers.get('access-control-allow-credentials'), 'true');
  assert.match(owner.headers.get('access-control-allow-headers')!, /idempotency-key/);
  const disallowedHeaders: Record<string, string>[] = [{ origin: 'https://unknown.com' }, { 'access-control-request-method': 'DELETE' },
    { 'access-control-request-headers': 'apikey, x-custom' }];
  for (const headers of disallowedHeaders) assert.equal((await preflight(headers)).status, 403);
  await f.json(`/projects/${credentials.projectId}/api-keys/${credentials.keyId}`, 'DELETE');
  assert.equal((await preflight()).status, 403);
});

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

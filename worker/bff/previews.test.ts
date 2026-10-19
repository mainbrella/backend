import test from 'node:test';
import assert from 'node:assert/strict';
import { Response as MfResponse, type V4FetchHandler } from 'miniflare';
import { BROWSER_PUBLIC_PATTERN, PREVIEW_LIMITS, consumePreviews, usablePreview } from './previews';
import { runtime } from './system-test-helpers';

const jpeg = Buffer.alloc(2048, 5); jpeg[0] = 0xff; jpeg[1] = 0xd8; jpeg[jpeg.length - 2] = 0xff; jpeg[jpeg.length - 1] = 0xd9;
const content = '<html><head><title>Example</title></head><body>This is a useful public website with enough real content for a preview screenshot.</body></html>';
const snapshot = (url: string, overrides: Record<string, unknown> = {}) => ({ success: true,
  result: { content, screenshot: jpeg.toString('base64') }, meta: { status: 200, title: 'Example', finalUrl: url }, ...overrides });
const outbound: V4FetchHandler = async request => {
  const url = new URL(request.url);
  if (url.hostname === 'cloudflare-dns.com') return MfResponse.json({ Status: 0, Answer: [url.searchParams.get('type') === 'A'
    ? { type: 1, data: '93.184.216.34' } : { type: 28, data: '2606:4700:4700::1111' }] });
  return new MfResponse(url.pathname === '/metadata' ? '<head><meta property="og:image" content="/og.jpg"></head>'
    : '<html><head><link rel="icon" href="/site.ico"></head><body>Plain page without metadata</body></html>');
};
type Fixture = Awaited<ReturnType<typeof runtime>>;
const project = async (f: Fixture, name = 'Preview project') => (await f.json('/projects', 'POST', { name, template: 'empty' }, 201)).project.id as string;
async function finished(f: Fixture, id: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const row = await f.db.prepare('SELECT * FROM bff_previews WHERE id=?').bind(id).first<any>();
    if (row && ['ready', 'failed'].includes(row.state)) return row;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Preview queue did not finish');
}

test('queued screenshots preserve metadata priority, deduplicate work, isolate project objects, serve JPEGs and expire cleanly', async t => {
  let renders = 0;
  const f = await runtime(t, {}, outbound, async request => {
    renders++;
    const { action, options } = await request.json() as any;
    assert.equal(action, 'snapshot');
    assert.deepEqual(options.viewport, { width: 1200, height: 630 });
    assert.deepEqual(options.screenshotOptions, { type: 'jpeg', quality: 80, fullPage: false });
    assert.equal(options.allowRequestPattern[0], BROWSER_PUBLIC_PATTERN);
    assert.equal(options.gotoOptions.timeout, 10_000);
    return MfResponse.json(snapshot(options.url));
  });
  const projectId = await project(f);
  assert.deepEqual(await f.json('/og-image', 'POST', { url: 'https://example.com/plain' }), { image: null });
  const metadata = await f.json('/og-image', 'POST', { url: 'https://example.com/metadata', projectId });
  assert.deepEqual(metadata, { image: 'https://example.com/og.jpg', source: 'og', status: 'ready' });
  assert.equal(renders, 0);
  const body = { url: 'https://example.com/plain', projectId };
  const [one, two] = await Promise.all([f.request('/og-image', 'POST', body), f.request('/og-image', 'POST', body)]);
  assert.ok([200, 202].includes(one.status)); assert.ok([200, 202].includes(two.status));
  const first = await one.json() as any, second = await two.json() as any;
  assert.equal(first.previewId, second.previewId);
  assert.equal(one.headers.get('retry-after'), '3');
  const row = await finished(f, first.previewId);
  assert.equal(row.state, 'ready', row.error);
  assert.equal(renders, 1);
  assert.equal((await f.db.prepare('SELECT previews FROM bff_daily_usage WHERE project_id=?').bind(projectId).first())?.previews, 1);
  assert.ok(row.object_key.startsWith(`products/bff/owner/${projectId}/previews/`));
  const statusPath = new URL(first.statusUrl).pathname.slice('/bff'.length);
  const status = await f.json(statusPath);
  assert.equal(status.source, 'screenshot'); assert.equal(status.status, 'ready');
  const image = await f.mf.dispatchFetch(status.image);
  assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/jpeg');
  assert.equal(image.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), jpeg);
  assert.equal((await f.mf.dispatchFetch(status.image, { method: 'HEAD' })).status, 200);
  assert.equal((await f.request(statusPath, 'GET', undefined, 'stranger')).status, 404);
  const cached = await f.json('/og-image', 'POST', body);
  assert.equal(cached.image, status.image); assert.equal(renders, 1);
  const other = await project(f, 'Other project');
  const isolated = await f.json('/og-image', 'POST', { ...body, projectId: other }, 202);
  const otherRow = await finished(f, isolated.previewId);
  assert.ok(otherRow.object_key.startsWith(`products/bff/owner/${other}/previews/`));
  assert.notEqual(otherRow.object_key, row.object_key);
  await f.db.prepare('UPDATE bff_projects SET suspended=1 WHERE id=?').bind(projectId).run();
  assert.equal((await f.mf.dispatchFetch(status.image)).status, 404);
  assert.equal((await f.request(statusPath)).status, 403);
  await f.db.prepare('UPDATE bff_projects SET suspended=0 WHERE id=?').bind(projectId).run();
  await f.db.prepare('UPDATE bff_previews SET expires_at=0 WHERE id=?').bind(first.previewId).run();
  assert.equal((await f.mf.dispatchFetch('https://internal/__test_preview_cleanup')).status, 200);
  const bucket = await f.mf.getR2Bucket('BUCKET') as unknown as R2Bucket;
  assert.equal(await bucket.head(row.object_key), null);
  assert.equal((await f.mf.dispatchFetch(status.image)).status, 404);
  assert.equal((await f.request(statusPath)).status, 404);
  await f.db.prepare('DELETE FROM bff_projects WHERE id=?').bind(other).run();
  await f.mf.dispatchFetch('https://internal/__test_preview_cleanup');
  assert.equal(await bucket.head(otherRow.object_key), null);
});

test('render failures retain favicon/placeholder fallbacks and cache failures without saving useless screenshots', async t => {
  let renders = 0;
  const f = await runtime(t, {}, outbound, async request => {
    renders++;
    const { options } = await request.json() as any;
    return MfResponse.json(snapshot(options.url, { meta: { status: 200, title: 'Just a moment...', finalUrl: options.url } }));
  });
  const projectId = await project(f);
  const input = { url: 'https://example.com/challenge', projectId };
  const pending = await f.json('/og-image', 'POST', input, 202);
  assert.equal(pending.source, 'favicon'); assert.equal(pending.image, 'https://example.com/site.ico');
  const row = await finished(f, pending.previewId);
  assert.equal(row.state, 'failed'); assert.equal(row.error, 'preview_unusable');
  assert.equal(row.object_key, null);
  const cached = await f.json('/og-image', 'POST', input);
  assert.equal(cached.status, 'failed'); assert.equal(cached.source, 'favicon'); assert.equal(renders, 1);
  await f.db.prepare("UPDATE bff_previews SET state='pending',lease_until=0 WHERE id=?").bind(pending.previewId).run();
  assert.equal((await f.request(new URL(pending.statusUrl).pathname.slice(4))).status, 202);
  assert.equal((await finished(f, pending.previewId)).state, 'failed');
  assert.equal(renders, 2, 'Polling recovers a job whose delivery lease expired');
  assert.equal((await (await f.mf.getR2Bucket('BUCKET') as unknown as R2Bucket).list()).objects.length, 0);
  const bucket = await f.mf.getR2Bucket('BUCKET') as unknown as R2Bucket;
  const uncertainKey = `products/bff/owner/${projectId}/previews/${row.url_hash}/${row.id}.jpg`;
  await bucket.put(uncertainKey, jpeg);
  await f.db.prepare('UPDATE bff_previews SET expires_at=0 WHERE id=?').bind(row.id).run();
  const renewed = await f.json('/og-image', 'POST', input, 202);
  assert.notEqual(renewed.previewId, row.id);
  assert.equal(await bucket.head(uncertainKey), null, 'Renewal cleans a previous upload whose ready acknowledgement was lost');
  await finished(f, renewed.previewId);
});

test('the overall browser deadline fails the job and cancels a late browser response', async t => {
  const f = await runtime(t);
  const projectId = await project(f), id = crypto.randomUUID();
  await f.db.prepare(`INSERT INTO bff_previews(id,project_id,user_id,url_hash,url,state,expires_at,created_at)
    VALUES(?,?,'owner','hash','https://example.com/','pending',?,?)`).bind(id, projectId, Date.now() + 600_000, Date.now()).run();
  const timeout = new AbortController(); let finish!: (response: Response) => void, canceled = false, acknowledged = false;
  t.mock.method(AbortSignal, 'timeout', () => timeout.signal);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ Status: 0, Answer: [{ type: 1, data: '93.184.216.34' }] }));
  const late = new Promise<Response>(resolve => { finish = resolve; });
  const env = { DB: f.db, BFF_ENABLED: 'true', BROWSER: { quickAction() {
    setTimeout(() => timeout.abort(new Error('timeout')), 0);
    return late;
  } } } as unknown as Env;
  await consumePreviews({ messages: [{ body: { id }, ack() { acknowledged = true; }, retry() { assert.fail('A timed out browser job should retain its fallback'); } }] } as unknown as MessageBatch, env);
  assert.equal(acknowledged, true);
  assert.equal((await f.db.prepare('SELECT error FROM bff_previews WHERE id=?').bind(id).first())?.error, 'preview_timeout');
  finish(new Response(new ReadableStream({ cancel() { canceled = true; } })));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(canceled, true);
});

test('browser jobs reject DNS answers with private addresses before rendering', async t => {
  let renders = 0;
  const f = await runtime(t, {}, async request => {
    if (new URL(request.url).hostname === 'cloudflare-dns.com') return MfResponse.json({ Status: 0, Answer: [{ type: 1, data: '127.0.0.1' }] });
    return new MfResponse('<html><head></head><body>Page without any image</body></html>');
  }, async () => { renders++; return MfResponse.json({}); });
  const projectId = await project(f);
  const pending = await f.json('/og-image', 'POST', { url: 'https://example.com/plain', projectId }, 202);
  const row = await finished(f, pending.previewId);
  assert.equal(row.error, 'preview_url_not_allowed'); assert.equal(renders, 0);
  const status = await f.json(new URL(pending.statusUrl).pathname.slice(4));
  assert.equal(status.source, 'placeholder'); assert.equal(status.image, null);
});

test('concurrent screenshot admissions share the project daily budget', async t => {
  let renders = 0;
  const f = await runtime(t, {}, outbound, async request => {
    renders++;
    const { options } = await request.json() as any;
    return MfResponse.json(snapshot(options.url));
  });
  const projectId = await project(f);
  await f.db.prepare('INSERT INTO bff_daily_usage(project_id,day,previews) VALUES(?,?,?)')
    .bind(projectId, new Date().toISOString().slice(0, 10), PREVIEW_LIMITS.jobsPerDay - 1).run();
  const responses = await Promise.all(['/one', '/two'].map(path => f.request('/og-image', 'POST', { url: `https://example.com${path}`, projectId })));
  assert.deepEqual(responses.map(response => response.status).sort(), [202, 429]);
  const accepted = await responses.find(response => response.status === 202)!.json() as any;
  assert.equal((await finished(f, accepted.previewId)).state, 'ready');
  assert.equal(renders, 1);
  assert.equal((await f.db.prepare('SELECT previews FROM bff_daily_usage WHERE project_id=?').bind(projectId).first())?.previews, PREVIEW_LIMITS.jobsPerDay);
});

test('project access is rechecked after browser rendering before writing an R2 image', async t => {
  let started!: () => void, release!: () => void;
  const rendering = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await runtime(t, {}, outbound, async request => {
    const { options } = await request.json() as any;
    started(); await gate;
    return MfResponse.json(snapshot(options.url));
  });
  const projectId = await project(f);
  const pending = await f.json('/og-image', 'POST', { url: 'https://example.com/plain', projectId }, 202);
  await rendering;
  await f.db.prepare('UPDATE bff_projects SET suspended=1 WHERE id=?').bind(projectId).run();
  release();
  assert.equal((await finished(f, pending.previewId)).error, 'project_paused');
  assert.equal((await (await f.mf.getR2Bucket('BUCKET') as unknown as R2Bucket).list()).objects.length, 0);
});

test('quality and browser request filters reject challenge, consent, error, blank and private targets', () => {
  assert.equal(usablePreview(content, { status: 200, title: 'Example' }), true);
  for (const title of ['Just a moment...', 'Access denied', 'Sign in', '404 Not Found', 'Verify you are human']) {
    assert.equal(usablePreview(content, { status: 200, title }), false, title);
  }
  assert.equal(usablePreview('<body><div id="onetrust-banner-sdk">Accept cookies</div></body>', { status: 200, title: 'Example' }), false);
  assert.equal(usablePreview('<html><body> </body></html>', { status: 200, title: 'Example' }), false);
  assert.equal(usablePreview(content, { status: 500, title: 'Example' }), false);
  const allowed = new RegExp(BROWSER_PUBLIC_PATTERN);
  for (const url of ['http://127.0.0.1/', 'http://2130706433/', 'http://10.1.2.3/', 'https://[::1]/',
    'https://localhost/', 'https://foo.internal/', 'https://evil.com:8443/', 'https://user:pass@example.com/', 'file:///etc/passwd']) assert.equal(allowed.test(url), false, url);
  assert.equal(allowed.test('https://example.com/path'), true);
  assert.equal(PREVIEW_LIMITS.cacheMs, 14 * 86400_000);
});

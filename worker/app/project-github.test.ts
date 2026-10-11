import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { handleProjectGithubRequest } from './project-github';
import { handleBuildRequest } from './build';
import { paidContainerFixture, SESSION_ONE, SESSION_TWO, USER_ONE, USER_TWO } from './paid-container-test-helpers';
import { githubBuildUserToken, sealGithubBuildCredentials } from '../lib/github-build';
import { sealGithubCredentials } from '../lib/github-import';
import { saveBuildGitVersion } from '../lib/build-git';
import { commitGithubSnapshot, syncGithubSource } from '../lib/build-github';
import { readBuildSource } from '../lib/build-storage';
import { BUILD_MAX_FILE_BYTES, BUILD_MAX_FILES, BUILD_MAX_SOURCE_BYTES } from '../lib/build-contract';
import type { BuildGitRuntime } from '../lib/build-git';
import type { BuildFiles, BuildParams, BuildTurnRow } from '../lib/build-contract';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const APP = PROJECT;
const REPO = 'acme/site';
const BRANCH = 'main';
const PARENT = 'a'.repeat(40);
const NEW_HEAD = 'c'.repeat(40);
const now = new Date().toISOString();
const request = (method: string, session = SESSION_ONE, body?: unknown, projectId = PROJECT, origin: string | null = 'https://mainbrella.com') => new Request(
  `https://api.mainbrella.com/projects/github?id=${projectId}`, { method,
    headers: { Cookie: `mainbrella_session=${session}`, ...(origin ? { Origin: origin } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
const packet = (line: string) => {
  const bytes = new TextEncoder().encode(line);
  return `${(bytes.length + 4).toString(16).padStart(4, '0')}${line}`;
};
const shaBlob = (bytes: Uint8Array) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

async function fixture(t: TestContext, options: { app?: boolean; source?: BuildFiles; head?: string | null; tree?: { path: string; sha: string; size: number; mode?: string; type?: string }[] } = {}) {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  const migrations = ['014_projects.sql', '015_project_domain.sql', '020_accounting_ledger.sql', '023_build.sql', '024_build_activity.sql', '025_build_images.sql',
    '026_build_ai_billing.sql', '027_build_model_effort.sql', '028_build_operations.sql', '029_remove_build_daily_limit.sql', '030_build_git.sql', '031_r2_billing.sql',
    '032_storage_retention.sql', '034_shared_projects.sql', '035_project_github.sql'];
  for (const migration of [...migrations.slice(0, 11), '028_github_import.sql', ...migrations.slice(11)])
    f.sqlite.exec(readFileSync(new URL(`../../migrations/${migration}`, import.meta.url), 'utf8'));
  const prepare = f.env.DB.prepare.bind(f.env.DB);
  f.env.DB.prepare = ((sql: string) => {
    const statement = prepare(sql);
    let proxy: D1PreparedStatement;
    proxy = new Proxy(statement, { get(target, property) {
      if (property === 'run') return async () => target.run();
      if (property === 'bind') return (...values: unknown[]) => { target.bind(...values); return proxy; };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    return proxy;
  }) as D1Database['prepare'];
  f.sqlite.prepare('INSERT INTO projects (id,user_id,name,created_at) VALUES (?,?,?,?)').run(PROJECT, USER_ONE, 'Site', now);
  f.env.DB.batch = (async statements => {
    f.sqlite.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      f.sqlite.exec('COMMIT');
      return results;
    } catch (error) { f.sqlite.exec('ROLLBACK'); throw error; }
  }) as D1Database['batch'];
  const files = options.source ?? {};
  if (options.app) addApp(f.sqlite, files);
  Object.assign(f.env, { GITHUB_BUILD_CLIENT_ID: 'build-client', GITHUB_BUILD_CLIENT_SECRET: 'build-secret',
    GITHUB_BUILD_APP_SLUG: 'mainbrella-build', GITHUB_BUILD_ENCRYPTION_KEY: 'b'.repeat(64), R2_BILLING_MODE: 'off',
    GITHUB_IMPORT_CLIENT_ID: 'import-client', GITHUB_IMPORT_CLIENT_SECRET: 'import-secret', GITHUB_IMPORT_APP_SLUG: 'mainbrella-import', GITHUB_IMPORT_ENCRYPTION_KEY: 'a'.repeat(64) });
  const credentials = await sealGithubBuildCredentials(f.env, USER_ONE, { access_token: 'ghu_build-test', refresh_token: 'ghr_build-test' });
  f.sqlite.prepare('INSERT INTO github_build_connections (user_id,github_user_id,github_login,credentials,expires_at) VALUES (?,?,?,?,?)')
    .run(USER_ONE, '456', 'builder', credentials, Date.now() + 60_000_000);

  const objects = new Map<string, Uint8Array>(), puts: string[] = [], deletes: string[][] = [], calls: { url: string; init?: RequestInit }[] = [];
  const writes: { url: string; body: unknown }[] = [];
  const bucket = {
    async get(key: string) { const value = objects.get(key); return value ? { size: value.length, arrayBuffer: async () => value.slice().buffer, body: new Response(value.slice().buffer).body } : null; },
    async put(key: string, value: string | ArrayBuffer | Uint8Array) { puts.push(key); objects.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value).slice()); return {}; },
    async list({ prefix = '', limit = 1000 }: R2ListOptions = {}) { const keys = [...objects.keys()].filter(key => key.startsWith(prefix)).sort(); return { objects: keys.slice(0, limit).map(key => ({ key })), truncated: keys.length > limit }; },
    async delete(keys: string | string[]) { const values = typeof keys === 'string' ? [keys] : keys; deletes.push(values); for (const key of values) objects.delete(key); },
  };
  f.env.BUCKET = bucket as unknown as R2Bucket;
  let head = options.head ?? null, failReceivePack = false, denyWrite = false, denyReceivePack = false;
  let tree = [...(options.tree ?? [])];
  const trees = new Map<string, typeof tree>();
  if (head) trees.set(head, tree);
  const blobs = new Map(tree.map((entry, index) => [entry.sha, new TextEncoder().encode(index === 0 ? '<main>Imported</main>' : '{"name":"imported"}') ]));
  const delegate = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); calls.push({ url, init });
    const parsed = new URL(url);
    if (parsed.hostname === 'github.com' && parsed.pathname.endsWith('/info/refs')) {
      if (denyReceivePack) return new Response('Resource not accessible by integration', { status: 403 });
      const refs = head ? packet(`${head} refs/heads/${BRANCH}\0report-status\n`) + '0000' : '0000';
      return new Response(packet('# service=git-receive-pack\n') + '0000' + refs, { headers: { 'Content-Type': 'application/x-git-receive-pack-advertisement' } });
    }
    if (parsed.hostname === 'github.com' && parsed.pathname.endsWith('/git-receive-pack')) {
      if (failReceivePack) return new Response('unavailable', { status: 500 });
      const wire = await new Response(init?.body as ReadableStream<Uint8Array>).text();
      const update = wire.match(/0{40} ([a-f0-9]{40}) refs\/heads\/main/);
      if (update) head = update[1];
      return new Response(packet('unpack ok\n') + packet('ok refs/heads/main\n'), { headers: { 'Content-Type': 'application/x-git-receive-pack-result' } });
    }
    if (parsed.hostname !== 'api.github.com') return delegate(input, init);
    if (init?.method === 'POST' && typeof init.body === 'string') writes.push({ url, body: JSON.parse(init.body) });
    if (parsed.pathname === `/repos/${REPO}`) return denyWrite
      ? Response.json({ message: 'Resource not accessible by integration' }, { status: 403 })
      : Response.json({ full_name: REPO, permissions: { push: true } });
    if (parsed.pathname === `/repos/${REPO}/git/ref/heads/${BRANCH}`) return denyWrite
      ? Response.json({ message: 'Resource not accessible by integration' }, { status: 403 })
      : head
      ? Response.json({ object: { sha: head } }) : Response.json({ message: 'Not Found' }, { status: 404 });
    if (parsed.pathname.startsWith(`/repos/${REPO}/git/trees/`) && init?.method !== 'POST') {
      const sha = parsed.pathname.split('/').at(-1)!;
      return Response.json({ truncated: false, tree: (trees.get(sha) ?? tree).map(entry => ({ mode: '100644', type: 'blob', ...entry })) });
    }
    if (parsed.pathname.startsWith(`/repos/${REPO}/git/blobs/`) && init?.method !== 'POST') {
      const bytes = blobs.get(parsed.pathname.split('/').at(-1)!);
      return bytes ? Response.json({ encoding: 'base64', content: Buffer.from(bytes).toString('base64') }) : Response.json({}, { status: 404 });
    }
    if (parsed.pathname === `/repos/${REPO}/git/blobs` && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)); const bytes = Buffer.from(body.content, 'base64');
      return Response.json({ sha: shaBlob(bytes) });
    }
    if (parsed.pathname === `/repos/${REPO}/git/trees` && init?.method === 'POST') return Response.json({ sha: 'b'.repeat(40) });
    if (parsed.pathname === `/repos/${REPO}/git/commits/${NEW_HEAD}`) return Response.json({ sha: NEW_HEAD, message: 'Checkpoint: Save app\n\nMainbrella-Turn: turn-build', parents: [{ sha: PARENT }] });
    if (parsed.pathname === `/repos/${REPO}/git/commits/${'f'.repeat(40)}`) return Response.json({ sha: 'f'.repeat(40), message: 'External commit', parents: [] });
    if (parsed.pathname === `/repos/${REPO}/git/commits/${PARENT}`) return Response.json({ sha: PARENT, tree: { sha: 'd'.repeat(40) }, message: 'Parent', parents: [] });
    if (parsed.pathname === `/repos/${REPO}/commits`) return Response.json(head ? [{ sha: head, commit: { message: 'Remote change', committer: { date: now } }, parents: [{ sha: PARENT }] }] : []);
    if (parsed.pathname === `/repos/${REPO}/compare/${PARENT}...${NEW_HEAD}`) return Response.json({ status: 'ahead' });
    if (parsed.pathname === `/repos/${REPO}/git/commits` && init?.method === 'POST') return Response.json({ sha: NEW_HEAD });
    if (parsed.pathname === `/repos/${REPO}/git/refs/heads/${BRANCH}` && init?.method === 'PATCH') { head = (JSON.parse(String(init.body)) as { sha: string }).sha; return Response.json({ ref: `refs/heads/${BRANCH}` }); }
    return Response.json({ message: `Unexpected mocked GitHub request: ${url}` }, { status: 500 });
  });
  return { ...f, objects, puts, deletes, calls, writes, get head() { return head; }, failReceivePack(value: boolean) { failReceivePack = value; },
    denyWrite(value: boolean) { denyWrite = value; }, denyReceivePack(value: boolean) { denyReceivePack = value; },
    setHead(value: string | null) { head = value; }, setTree(value: typeof tree) { tree = value; if (head) trees.set(head, value); },
    setCommitTree(sha: string, entries: typeof tree, contents: Record<string, string>) {
      trees.set(sha, entries);
      for (const [path, content] of Object.entries(contents)) {
        const entry = entries.find(candidate => candidate.path === path);
        if (entry) blobs.set(entry.sha, new TextEncoder().encode(content));
      }
    }, addBlob(sha: string, bytes: Uint8Array) { blobs.set(sha, new Uint8Array(bytes)); } };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
function addApp(sqlite: Fixture['sqlite'], files: BuildFiles) {
  sqlite.prepare(`INSERT INTO build_apps(id,user_id,create_key,initial_prompt,name,source_json,created_at,updated_at,project_id)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(APP, USER_ONE, 'project:' + PROJECT, '', 'Site', JSON.stringify(files), now, now, PROJECT);
}
function row(f: Fixture, sql: string, ...params: unknown[]): Record<string, unknown> {
  const result = f.sqlite.prepare(sql).get(...params as never[]);
  assert.ok(result, `expected row for ${sql}`);
  return result as Record<string, unknown>;
}
const workingSource = (f: Fixture) => readBuildSource(f.env, { userId: USER_ONE, appId: APP }, row(f, 'SELECT source_json FROM build_apps WHERE id=?', APP).source_json as string);
function insertTurn(f: Fixture, id: string, status = 'running') {
  f.sqlite.prepare(`INSERT INTO build_turns(id,app_id,user_id,request_key,prompt,mode,base_revision,status,stage,model,created_at)
    VALUES(?,?,?,?,?,'build',0,?,'Building','model',?)`).run(id, APP, USER_ONE, id, 'Save app', status, now);
  f.sqlite.prepare('UPDATE build_apps SET active_turn_id=? WHERE id=?').run(status === 'running' ? id : null, APP);
}
function runtime(f: Fixture, cached = false): BuildGitRuntime {
  return { async run() { return { status: 'succeeded', stdout: '', stderr: '' }; }, async write() {},
    async read() { return new Response(null, { status: 404 }); }, async persist(_label, action) { if (!cached) await action(); } };
}
function params(turnId: string): BuildParams { return { appId: APP, userId: USER_ONE, turnId }; }
function turn(turnId: string): BuildTurnRow { return { id: turnId, app_id: APP, user_id: USER_ONE, request_key: turnId, prompt: 'Save app', mode: 'build',
  base_revision: 0, log: '', status: 'running', stage: 'Building', summary: null, error: null, model: 'model', input_tokens: 0, output_tokens: 0,
  created_at: now, finished_at: null, restore_version_id: null }; }
function link(f: Fixture, body: unknown = { repo: REPO, branch: BRANCH }, origin: string | null = 'https://mainbrella.com') { return handleProjectGithubRequest(request('PUT', SESSION_ONE, body, PROJECT, origin), f.env); }
function setLinked(f: Fixture, head = PARENT, paths: string[] = ['index.html']) {
  f.sqlite.prepare('UPDATE projects SET github_repo=?,github_branch=?,github_commit_id=?,github_paths_json=? WHERE id=?')
    .run(REPO, BRANCH, head, JSON.stringify(paths), PROJECT);
}
function addLocalVersion(f: Fixture, localSha = 'e'.repeat(40)) {
  const id = 'turn-local';
  insertTurn(f, id);
  f.sqlite.prepare(`INSERT INTO build_git_versions(id,app_id,parent_version_id,commit_id,bundle_key,source_json,lockfile,assets_json,message,verified,created_at)
    VALUES(?,?,NULL,?,'build-git/local','{}',NULL,'[]','Local history',0,?)`).run(id, APP, localSha, now);
  f.sqlite.prepare('UPDATE build_turns SET status=\'succeeded\' WHERE id=?').run(id);
  f.sqlite.prepare('UPDATE build_apps SET git_version_id=?,active_turn_id=NULL WHERE id=?').run(id, APP);
}

test('a plain project at the Builder app limit does not write to GitHub', async t => {
  const f = await fixture(t, { source: { 'index.html': 'local draft' } });
  for (let index = 0; index < 50; index++) f.sqlite.prepare(`INSERT INTO build_apps(id,user_id,create_key,initial_prompt,name,source_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?)`).run(crypto.randomUUID(), USER_ONE, `limit-${index}`, '', 'Existing app', '{}', now, now);
  const response = await link(f);
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: 'build_app_limit' });
  assert.equal(f.writes.length, 0);
  assert.ok(!f.calls.some(call => call.url.endsWith('/git-receive-pack')));
  assert.equal(row(f, 'SELECT github_repo,github_link_lock FROM projects WHERE id=?', PROJECT).github_repo, null);
  assert.equal(row(f, 'SELECT github_link_lock FROM projects WHERE id=?', PROJECT).github_link_lock, null);
});

test('a project cannot be deleted while its GitHub transfer holds the lock', async t => {
  const f = await fixture(t, { app: true });
  f.sqlite.prepare('UPDATE projects SET github_link_lock=?,github_link_until=? WHERE id=?').run('transfer-lock', Date.now() + 60_000, PROJECT);
  const response = await handleBuildRequest(new Request(`https://api.mainbrella.com/build/apps/${APP}`, {
    method: 'DELETE', headers: { Origin: 'https://mainbrella.com', Cookie: `mainbrella_session=${SESSION_ONE}` },
  }), f.env);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'github_project_busy' });
  assert.throws(() => f.sqlite.prepare('DELETE FROM build_apps WHERE id=?').run(APP), /github_project_busy/);
  assert.equal(row(f, 'SELECT id FROM build_apps WHERE id=?', APP).id, APP);
});

test('project GitHub routes enforce ownership and do not reuse Import authorization', async t => {
  const f = await fixture(t);
  const importCredentials = await sealGithubCredentials(f.env, USER_ONE, { access_token: 'ghu_import-only', refresh_token: 'ghr_import-only' });
  f.sqlite.prepare('DELETE FROM github_build_connections WHERE user_id=?').run(USER_ONE);
  f.sqlite.prepare('INSERT INTO github_import_connections (user_id,github_user_id,github_login,credentials,expires_at) VALUES (?,?,?,?,?)')
    .run(USER_ONE, '123', 'import-user', importCredentials, Date.now() + 60_000_000);
  const missing = await handleProjectGithubRequest(request('GET', SESSION_ONE, undefined, '22222222-2222-4222-8222-222222222222'), f.env);
  assert.equal(missing.status, 404);
  const other = await handleProjectGithubRequest(request('PUT', 'browser-session-two', { repo: REPO, branch: BRANCH }), f.env);
  assert.equal(other.status, 404);
  const unconnected = await link(f);
  assert.equal(unconnected.status, 400);
  assert.deepEqual(await unconnected.json(), { error: 'github_connection_required' });
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await (await handleProjectGithubRequest(request('GET'), f.env)).json(), { github: null });
});

test('a running Build turn holds the project link lock', async t => {
  const f = await fixture(t, { app: true, source: { 'index.html': 'source' } });
  insertTurn(f, 'turn-active');
  const response = await link(f);
  assert.equal(response.status, 409, JSON.stringify({ body: await response.clone().json(), calls: f.calls.map(call => call.url) }));
  assert.deepEqual(await response.json(), { error: 'github_project_busy' });
  assert.equal(row(f, 'SELECT github_repo FROM projects WHERE id=?', PROJECT).github_repo, null);
  assert.equal(f.calls.filter(call => call.url.endsWith('/git-receive-pack') && call.init?.method === 'POST').length, 0);
});

test('a branch conflict leaves local Git history and project source untouched', async t => {
  const f = await fixture(t, { app: true, source: { 'index.html': 'original' }, head: 'f'.repeat(40) });
  addLocalVersion(f, 'e'.repeat(40));
  const beforeSource = row(f, 'SELECT source_json FROM build_apps WHERE id=?', APP).source_json;
  const response = await link(f);
  assert.equal(response.status, 409, JSON.stringify({ body: await response.clone().json(), calls: f.calls.map(call => call.url) }));
  assert.deepEqual(await response.json(), { error: 'github_branch_conflict' });
  assert.equal(row(f, 'SELECT github_repo FROM projects WHERE id=?', PROJECT).github_repo, null);
  assert.equal(row(f, 'SELECT git_version_id FROM build_apps WHERE id=?', APP).git_version_id, 'turn-local');
  assert.equal(row(f, 'SELECT source_json FROM build_apps WHERE id=?', APP).source_json, beforeSource);
  assert.equal(row(f, 'SELECT COUNT(*) AS n FROM build_git_versions').n, 1);
});

test('failed remote migration never switches the project off hosted Git', async t => {
  const f = await fixture(t, { app: true, source: { 'index.html': '<main>Local source</main>' } });
  f.failReceivePack(true);
  const response = await link(f);
  assert.equal(response.status, 503);
  assert.equal(row(f, 'SELECT github_repo FROM projects WHERE id=?', PROJECT).github_repo, null);
  assert.deepEqual(JSON.parse(row(f, 'SELECT source_json FROM build_apps WHERE id=?', APP).source_json as string), { 'index.html': '<main>Local source</main>' });
  assert.equal(row(f, 'SELECT COUNT(*) AS n FROM build_git_versions').n, 0);
  assert.equal(row(f, 'SELECT github_link_lock FROM projects WHERE id=?', PROJECT).github_link_lock, null);
});

test('an empty GitHub repository is initialized before the project link is switched', async t => {
  const local = { 'index.html': '<main>Local source</main>' };
  const f = await fixture(t, { app: true, source: local });
  const response = await link(f);
  assert.equal(response.status, 200);
  const data = await response.json() as { github: { commitId: string } };
  assert.match(data.github.commitId, /^[a-f0-9]{40}$/);
  assert.equal(f.head, data.github.commitId);
  assert.equal(row(f, 'SELECT github_repo FROM projects WHERE id=?', PROJECT).github_repo, REPO);
  assert.deepEqual(await workingSource(f), local);
  assert.equal(row(f, 'SELECT github_cleanup_pending FROM projects WHERE id=?', PROJECT).github_cleanup_pending, 0);
  assert.ok(f.puts.length > 0);
  assert.ok(f.puts.every(key => key.includes('/objects/')));
  assert.ok(f.calls.some(call => call.url.endsWith('/git-receive-pack') && call.init?.method === 'POST'));
});

test('connecting an empty hosted project imports the existing repository source and cleans only Git bundles and parts', async t => {
  const html = new TextEncoder().encode('<main>Imported</main>'), manifest = new TextEncoder().encode('{"name":"imported"}');
  const htmlSha = shaBlob(html), manifestSha = shaBlob(manifest), remoteHead = '9'.repeat(40);
  const f = await fixture(t, { head: remoteHead, tree: [
    { path: 'index.html', sha: htmlSha, size: html.length, mode: '100644', type: 'blob' }, { path: 'package.json', sha: manifestSha, size: manifest.length, mode: '100644', type: 'blob' },
  ] });
  // The mock's blob bytes follow the tree entry order.
  const sourceKey = `build-git/${USER_ONE}/${PROJECT}/objects/source.json`;
  const bundleKey = `build-git/${USER_ONE}/${PROJECT}/bundles/old.json`;
  const partKey = `build-git/${USER_ONE}/${PROJECT}/parts/old.pack`;
  f.objects.set(sourceKey, new TextEncoder().encode('source object'));
  f.objects.set(bundleKey, new TextEncoder().encode('bundle'));
  f.objects.set(partKey, new TextEncoder().encode('part'));
  const response = await link(f);
  assert.equal(response.status, 200);
  const data = await response.json() as { github: { commitId: string } };
  assert.equal(data.github.commitId, remoteHead);
  assert.equal(row(f, 'SELECT github_repo FROM projects WHERE id=?', PROJECT).github_repo, REPO);
  assert.deepEqual(await workingSource(f), {
    'index.html': '<main>Imported</main>', 'package.json': '{"name":"imported"}',
  });
  assert.equal(f.objects.has(sourceKey), true);
  assert.equal(f.objects.has(bundleKey), false);
  assert.equal(f.objects.has(partKey), false);
  assert.equal(row(f, 'SELECT github_cleanup_pending FROM projects WHERE id=?', PROJECT).github_cleanup_pending, 0);
  assert.ok(f.puts.every(key => key.includes('/objects/')));
});

test('GitHub imports accept large datasets and more than 80 files while keeping D1 and Workflow source references small', async t => {
  const files: BuildFiles = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`src/module-${index}.ts`, `// Module ${index}\n${' '.repeat(24 * 1024)}`]));
  files['card-2026.json'] = JSON.stringify({ hands: Array.from({ length: 6000 }, (_, id) => ({ id, tiles: '222 000 2222 6666' })) });
  assert.ok(Buffer.byteLength(files['card-2026.json']) > 64 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(files)) > 2 * 1024 * 1024);
  const entries = Object.entries(files).map(([path, content]) => ({ path, sha: shaBlob(Buffer.from(content)), size: Buffer.byteLength(content) }));
  const f = await fixture(t, { head: PARENT, tree: entries });
  f.setCommitTree(PARENT, entries, files);
  const response = await link(f);
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const stored = row(f, 'SELECT source_json FROM build_apps WHERE id=?', APP).source_json as string;
  assert.ok(Buffer.byteLength(stored) < 512);
  assert.ok(JSON.parse(stored).$r2);
  assert.deepEqual(await workingSource(f), files);
  assert.ok(f.puts.every(key => key.includes('/objects/')));
});

test('GitHub import resource ceilings reject before fetching blobs and preserve the unlinked project', async t => {
  const cases = [
    [{ path: 'large.json', sha: PARENT, size: BUILD_MAX_FILE_BYTES + 1 }],
    Array.from({ length: BUILD_MAX_FILES + 1 }, (_, index) => ({ path: `src/file-${index}.ts`, sha: PARENT, size: 1 })),
    Array.from({ length: BUILD_MAX_SOURCE_BYTES / BUILD_MAX_FILE_BYTES + 1 }, (_, index) => ({ path: `data/file-${index}.json`, sha: PARENT, size: BUILD_MAX_FILE_BYTES })),
  ];
  for (const tree of cases) await t.test(`${tree.length} entries, ${tree[0].size} bytes per file`, async sub => {
    const f = await fixture(sub, { head: PARENT, tree });
    const response = await link(f);
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: 'github_source_limit' });
    assert.equal(row(f, 'SELECT github_repo FROM projects WHERE id=?', PROJECT).github_repo, null);
    assert.equal(row(f, 'SELECT COUNT(*) AS n FROM build_apps').n, 0);
    assert.equal(f.calls.some(call => call.url.includes('/git/blobs/')), false);
    assert.deepEqual(f.puts, []);
  });
});

test('linked builds commit directly to GitHub without writing a local version or R2 bundle', async t => {
  const f = await fixture(t, { app: true, source: { 'index.html': 'old' }, head: PARENT });
  setLinked(f, PARENT, ['index.html']);
  const turnId = 'turn-build'; insertTurn(f, turnId);
  const result = await saveBuildGitVersion(f.env, params(turnId), runtime(f), turn(turnId), { 'index.html': 'new' }, true);
  assert.equal(result.commit_id, NEW_HEAD);
  assert.equal(f.head, NEW_HEAD);
  assert.equal(row(f, 'SELECT github_commit_id FROM projects WHERE id=?', PROJECT).github_commit_id, NEW_HEAD);
  assert.equal(row(f, 'SELECT github_verified_commit_id FROM build_apps WHERE id=?', APP).github_verified_commit_id, NEW_HEAD);
  assert.equal(row(f, 'SELECT COUNT(*) AS n FROM build_git_versions').n, 0);
  assert.deepEqual(f.puts, []);
  assert.ok(f.calls.some(call => call.url.includes('/git/refs/heads/main') && call.init?.method === 'PATCH'));
});

test('revoked GitHub write access never falls back to local Git storage', async t => {
  const f = await fixture(t, { app: true, source: { 'index.html': 'old' }, head: PARENT });
  setLinked(f);
  const turnId = 'turn-build'; insertTurn(f, turnId); f.denyWrite(true);
  await assert.rejects(saveBuildGitVersion(f.env, params(turnId), runtime(f), turn(turnId), { 'index.html': 'new' }, false), /github_write_access_required/);
  assert.equal(row(f, 'SELECT github_commit_id FROM projects WHERE id=?', PROJECT).github_commit_id, PARENT);
  assert.equal(row(f, 'SELECT COUNT(*) AS n FROM build_git_versions').n, 0);
  assert.deepEqual(f.puts, []);
  assert.ok(f.calls.some(call => call.url.endsWith('/git/ref/heads/main')));
});

test('a lost D1 head update reconciles the accepted GitHub commit on retry', async t => {
  const f = await fixture(t, { app: true, source: { 'index.html': 'old' }, head: PARENT });
  setLinked(f, PARENT, ['index.html']);
  const turnId = 'turn-build'; insertTurn(f, turnId);
  const originalPrepare = f.env.DB.prepare.bind(f.env.DB); let lose = true; const statements: string[] = [];
  f.env.DB.prepare = ((sql: string) => {
    statements.push(sql);
    const statement = originalPrepare(sql);
    let proxy: D1PreparedStatement;
    proxy = new Proxy(statement, { get(target, property) {
      if (property === 'run' && sql.trimStart().startsWith('UPDATE projects SET github_commit_id=')) return async () => {
        if (lose) { lose = false; throw new Error('simulated lost D1 write response'); }
        return target.run();
      };
      if (property === 'bind') return (...values: unknown[]) => { (target as D1PreparedStatement).bind(...values); return proxy; };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    return proxy;
  }) as D1Database['prepare'];
  let lostWrite: unknown;
  try { await saveBuildGitVersion(f.env, params(turnId), runtime(f), turn(turnId), { 'index.html': 'new' }, false); } catch (error) { lostWrite = error; }
  assert.match(String(lostWrite), /simulated lost D1 write response/, `loss injector=${lose}, statements=${JSON.stringify(statements)}`);
  assert.equal(f.head, NEW_HEAD);
  assert.equal(row(f, 'SELECT github_commit_id FROM projects WHERE id=?', PROJECT).github_commit_id, PARENT);
  const retried = await saveBuildGitVersion(f.env, params(turnId), runtime(f), turn(turnId), { 'index.html': 'new' }, false);
  assert.equal(retried.commit_id, NEW_HEAD);
  assert.equal(row(f, 'SELECT github_commit_id FROM projects WHERE id=?', PROJECT).github_commit_id, NEW_HEAD);
  assert.equal(f.calls.filter(call => call.init?.method === 'PATCH').length, 1);
  assert.equal(row(f, 'SELECT COUNT(*) AS n FROM build_git_versions').n, 0);
  assert.deepEqual(f.puts, []);
});

test('linked version browsing uses GitHub SHA IDs and remains owner-scoped', async t => {
  const f = await fixture(t, { app: true, source: { 'index.html': 'source' }, head: NEW_HEAD,
    tree: [{ path: 'index.html', sha: shaBlob(new TextEncoder().encode('<main>Imported</main>')), size: 22 }] });
  setLinked(f, NEW_HEAD);
  f.sqlite.prepare('UPDATE build_apps SET github_verified_commit_id=? WHERE id=?').run(NEW_HEAD, APP);
  const versionsRequest = (session: string) => new Request(`https://api.mainbrella.com/build/apps/${APP}/versions`, {
    headers: { Cookie: `mainbrella_session=${session}`, Origin: 'https://mainbrella.com' },
  });
  const versions = await handleBuildRequest(versionsRequest(SESSION_ONE), f.env);
  assert.equal(versions.status, 200);
  const listing = await versions.json() as { versions: { id: string; commitId: string; verified: boolean }[]; versionId: string };
  assert.equal(listing.versionId, NEW_HEAD);
  assert.equal(listing.versions[0]?.id, NEW_HEAD);
  assert.equal(listing.versions[0]?.commitId, NEW_HEAD);
  assert.equal(listing.versions[0]?.verified, true);
  const filesResponse = await handleBuildRequest(new Request(`https://api.mainbrella.com/build/apps/${APP}/files?versionId=${NEW_HEAD}`, {
    headers: { Cookie: `mainbrella_session=${SESSION_ONE}`, Origin: 'https://mainbrella.com' },
  }), f.env);
  assert.equal(filesResponse.status, 200);
  const fileListing = await filesResponse.json() as { version: { id: string }; files: { path: string }[] };
  assert.equal(fileListing.version.id, NEW_HEAD);
  assert.deepEqual(fileListing.files.map(file => file.path), ['index.html']);
  const detail = await handleBuildRequest(new Request(`https://api.mainbrella.com/build/apps/${APP}/versions/${NEW_HEAD}`, {
    headers: { Cookie: `mainbrella_session=${SESSION_ONE}`, Origin: 'https://mainbrella.com' },
  }), f.env);
  assert.equal(detail.status, 200);
  const data = await detail.json() as { version: { id: string }; files: { path: string }[] };
  assert.equal(data.version?.id, NEW_HEAD, JSON.stringify(data));
  assert.deepEqual(data.files.map(file => file.path), ['index.html']);
  const other = await handleBuildRequest(versionsRequest(SESSION_TWO), f.env);
  assert.equal(other.status, 404);
  assert.deepEqual(await other.json(), { error: 'app_not_found' });
});

test('an external GitHub head syncs repository files into the active Build workspace', async t => {
  const base = { 'index.html': 'base', 'local.txt': 'before local edit' };
  const remote = { 'index.html': 'external update', 'local.txt': 'before local edit', 'remote.txt': 'external file' };
  const toEntries = (files: Record<string, string>) => Object.entries(files).map(([path, content]) => ({ path, sha: shaBlob(new TextEncoder().encode(content)), size: content.length }));
  const externalHead = 'f'.repeat(40);
  const f = await fixture(t, { app: true, source: { ...base, 'local.txt': 'unsaved local edit' }, head: PARENT, tree: toEntries(base) });
  f.setCommitTree(PARENT, toEntries(base), base);
  f.setCommitTree(externalHead, toEntries(remote), remote);
  setLinked(f, PARENT, Object.keys(base));
  const turnId = 'turn-build'; insertTurn(f, turnId);
  f.setHead(externalHead);
  const project = await syncGithubSource(f.env, params(turnId));
  assert.equal(project?.github_commit_id, externalHead);
  assert.equal(row(f, 'SELECT github_commit_id FROM projects WHERE id=?', PROJECT).github_commit_id, externalHead);
  assert.deepEqual(await workingSource(f), {
    'index.html': 'external update', 'local.txt': 'unsaved local edit', 'remote.txt': 'external file',
  });
});

test('overlapping local and remote edits stop sync without changing the working source or GitHub pointer', async t => {
  const base = { 'index.html': 'base' }, local = { 'index.html': 'local change' }, remote = { 'index.html': 'remote change' };
  const toEntries = (files: Record<string, string>) => Object.entries(files).map(([path, content]) => ({ path, sha: shaBlob(new TextEncoder().encode(content)), size: content.length }));
  const externalHead = 'f'.repeat(40);
  const f = await fixture(t, { app: true, source: local, head: PARENT, tree: toEntries(base) });
  f.setCommitTree(PARENT, toEntries(base), base);
  f.setCommitTree(externalHead, toEntries(remote), remote);
  setLinked(f, PARENT, Object.keys(base));
  const turnId = 'turn-build'; insertTurn(f, turnId); f.setHead(externalHead);
  await assert.rejects(syncGithubSource(f.env, params(turnId)), { message: 'github_source_conflict', details: 'Conflicting file: index.html' });
  assert.equal(row(f, 'SELECT github_commit_id FROM projects WHERE id=?', PROJECT).github_commit_id, PARENT);
  assert.deepEqual(JSON.parse(row(f, 'SELECT source_json FROM build_apps WHERE id=?', APP).source_json as string), local);
});

test('a cached persistence callback returns the already accepted GitHub SHA', async t => {
  const f = await fixture(t, { app: true, source: { 'index.html': 'new' }, head: NEW_HEAD });
  setLinked(f, NEW_HEAD, ['index.html']);
  const turnId = 'turn-build'; insertTurn(f, turnId);
  const result = await saveBuildGitVersion(f.env, params(turnId), runtime(f, true), turn(turnId), { 'index.html': 'new' }, true);
  assert.equal(result.id, NEW_HEAD);
  assert.equal(result.commit_id, NEW_HEAD);
  assert.deepEqual(f.calls, []);
  assert.equal(row(f, 'SELECT github_verified_commit_id FROM build_apps WHERE id=?', APP).github_verified_commit_id, null);
});

test('managed deletions are explicit while unrelated repository files remain in the base tree', async t => {
  const existing = ['index.html', 'managed.txt', 'unmanaged.txt'].map((path, i) => ({ path, sha: String(i + 1).repeat(40), size: 5 }));
  const f = await fixture(t, { head: PARENT, tree: existing });
  const token = await githubBuildUserToken(f.env, USER_ONE);
  const result = await commitGithubSnapshot(REPO, BRANCH, PARENT, ['index.html', 'managed.txt'],
    { 'index.html': new TextEncoder().encode('changed') }, 'Update files', now, token);
  assert.equal(result, NEW_HEAD);
  const treeWrite = f.writes.find(write => write.url.endsWith('/git/trees'));
  assert.ok(treeWrite);
  const body = treeWrite.body as { base_tree: string; tree: { path: string; sha: string | null }[] };
  assert.equal(body.base_tree, 'd'.repeat(40));
  assert.ok(body.tree.some(entry => entry.path === 'managed.txt' && entry.sha === null));
  assert.equal(body.tree.some(entry => entry.path === 'unmanaged.txt'), false);
});

test('the Build app receive-pack grant is checked even when repository user permissions allow push', async t => {
  const f = await fixture(t); f.denyReceivePack(true);
  const response = await link(f);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'github_write_access_required' });
  assert.ok(f.calls.some(call => call.url === `https://api.github.com/repos/${REPO}`));
  assert.ok(f.calls.some(call => call.url.endsWith('/info/refs?service=git-receive-pack')));
  assert.equal(row(f, 'SELECT github_repo FROM projects WHERE id=?', PROJECT).github_repo, null);
});

test('project linking defaults to main and rejects missing Origin or unsafe branches', async t => {
  const f = await fixture(t);
  const missingOrigin = await link(f, { repo: REPO }, null);
  assert.equal(missingOrigin.status, 403);
  assert.deepEqual(await missingOrigin.json(), { error: 'origin_required' });
  const invalid = await link(f, { repo: REPO, branch: 'main..unsafe' });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: 'invalid_request' });
  const response = await link(f, { repo: REPO });
  assert.equal(response.status, 200);
  const data = await response.json() as { github: { branch: string } };
  assert.equal(data.github.branch, 'main');
});

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { paidContainerFixture, USER_ONE, SESSION_ONE, SESSION_TWO, GENERATION_ONE, EXPIRES_AT } from './paid-container-test-helpers';
import { buildBillingFixture } from './build-billing-test-helpers';
import { handleBuildRequest } from './build';
import { runBuildAgent } from '../lib/build-agent';
import { BUILD_MODEL, buildStarter, type BuildAppRow, type BuildFiles, type BuildParams, type BuildTurnRow } from '../lib/build-contract';
import { BUILD_GIT_ROOT, buildGitVersion, hydrateBuildGit, saveBuildGitVersion, type BuildGitRuntime } from '../lib/build-git';
import { buildImagePath } from '../lib/build-images';

async function fixture(t: TestContext) {
  const f = await paidContainerFixture(t);
  t.after(() => f.close());
  for (const name of ['023_build.sql', '024_build_activity.sql', '025_build_images.sql', '027_build_model_effort.sql',
    '028_build_operations.sql', '029_remove_build_daily_limit.sql', '030_build_git.sql'])
    f.sqlite.exec(readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8'));
  await buildBillingFixture(f.env, f.sqlite, USER_ONE);
  // D1 batches commit atomically, including the head guard trigger.
  f.env.DB.batch = (async (statements: D1PreparedStatement[]) => {
    f.sqlite.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      f.sqlite.exec('COMMIT');
      return results;
    } catch (error) { f.sqlite.exec('ROLLBACK'); throw error; }
  }) as D1Database['batch'];

  const objects = new Map<string, Uint8Array<ArrayBuffer>>(), puts: string[] = [];
  const bucket = {
    async get(key: string) {
      const bytes = objects.get(key);
      return bytes ? { size: bytes.byteLength, arrayBuffer: async () => bytes.slice().buffer,
        json: async () => JSON.parse(new TextDecoder().decode(bytes)) } : null;
    },
    async put(key: string, value: string | ArrayBuffer, options?: R2PutOptions) {
      puts.push(key);
      if (options?.onlyIf && 'etagDoesNotMatch' in options.onlyIf && options.onlyIf.etagDoesNotMatch === '*' && objects.has(key)) return null;
      const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value).slice();
      if (options?.sha256) assert.equal(createHash('sha256').update(bytes).digest('hex'), options.sha256);
      objects.set(key, bytes);
      return {};
    },
    async list({ prefix, limit = 1000 }: R2ListOptions = {}) {
      const keys = [...objects.keys()].filter(key => key.startsWith(prefix ?? '')).sort();
      return { objects: keys.slice(0, limit).map(key => ({ key })), truncated: keys.length > limit };
    },
    async delete(keys: string | string[]) { for (const key of typeof keys === 'string' ? [keys] : keys) objects.delete(key); },
  };
  f.env.BUCKET = bucket as unknown as R2Bucket;

  const disk = mkdtempSync(join(tmpdir(), 'mainbrella-build-git-'));
  t.after(() => rmSync(disk, { recursive: true, force: true }));
  const localPath = (path: string) => {
    assert.ok(path.startsWith('/workspace/'), `Unexpected guest path: ${path}`);
    return join(disk, path.slice('/workspace/'.length));
  };
  const attempts = new Map<string, number>();
  const step = {
    async do(name: string, options: { retries?: { limit: number } }, operation: () => Promise<unknown>) {
      for (let attempt = 0; ; attempt++) {
        attempts.set(name, (attempts.get(name) ?? 0) + 1);
        try { return structuredClone(await operation()); }
        catch (error) { if (attempt >= (options.retries?.limit ?? 0)) throw error; }
      }
    },
    async sleep() { assert.fail('Test executions complete immediately'); },
  };
  const commands: string[] = [];
  const runtime: BuildGitRuntime = {
    async run(_label, command) {
      commands.push(command);
      const result = spawnSync('bash', ['-c', command.replaceAll('/workspace', disk)], { cwd: disk, encoding: 'utf8' });
      return { status: result.status === 0 ? 'succeeded' : 'failed', stdout: result.stdout ?? '', stderr: result.stderr || String(result.error ?? '') };
    },
    async write(path, content) {
      if (path === `${BUILD_GIT_ROOT}/input.json`) {
        const input = JSON.parse(typeof content === 'string' ? content : new TextDecoder().decode(content));
        input.worktree = localPath(input.worktree); content = JSON.stringify(input);
      }
      mkdirSync(dirname(localPath(path)), { recursive: true });
      writeFileSync(localPath(path), content);
    },
    async read(path) {
      try { return new Response(new Uint8Array(readFileSync(localPath(path)))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Response(null, { status: 404 }); throw error; }
    },
    async persist(label, action) { await step.do(label, { retries: { limit: 2 } }, action); },
  };

  const appId = crypto.randomUUID(), now = new Date().toISOString();
  f.sqlite.prepare('INSERT INTO build_apps (id,user_id,create_key,initial_prompt,name,source_json,container_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(appId, USER_ONE, appId, 'Build an app', 'Test app', JSON.stringify(buildStarter),
      JSON.stringify({ id: 'small', createdAt: GENERATION_ONE, expiresAt: EXPIRES_AT }), now, now);
  const app = () => f.sqlite.prepare('SELECT * FROM build_apps WHERE id = ?').get(appId) as unknown as BuildAppRow;
  const turn = (params: BuildParams) => f.sqlite.prepare('SELECT * FROM build_turns WHERE id = ?').get(params.turnId) as unknown as BuildTurnRow;
  function startTurn(mode: 'build' | 'preview' = 'build', restoreId: string | null = null): BuildParams {
    f.sqlite.prepare("UPDATE build_turns SET status = 'succeeded' WHERE app_id = ? AND status IN ('queued','running')").run(appId);
    f.sqlite.prepare('UPDATE build_apps SET active_turn_id = NULL WHERE id = ?').run(appId);
    const turnId = crypto.randomUUID();
    f.sqlite.prepare(`INSERT INTO build_turns (id,app_id,user_id,request_key,prompt,mode,base_revision,status,stage,model,created_at,restore_version_id)
      VALUES(?,?,?,?,?,?,?,'running','Building',?,?,?)`).run(turnId, appId, USER_ONE, turnId, 'Build an app', mode, app().revision, BUILD_MODEL, now, restoreId);
    f.sqlite.prepare('UPDATE build_apps SET active_turn_id = ? WHERE id = ?').run(turnId, appId);
    return { appId, userId: USER_ONE, turnId };
  }
  const params = startTurn();
  const dispatched: unknown[] = [];
  Object.assign(f.env, { BUILD_ENABLED: 'true', PREVIEWS_ENABLED: 'true', PREVIEW_DOMAIN: 'mainbrella.dev',
    BUILD_WORKFLOW: { async create(options: unknown) { dispatched.push(options); } } });
  f.sqlite.exec(readFileSync(new URL('../../preview-migrations/001_preview_routes.sql', import.meta.url), 'utf8'));
  f.env.PREVIEW_ROUTES = { prepare(sql: string) {
    const statement = f.env.DB.prepare(sql), run = statement.run.bind(statement);
    statement.run = (async () => ({ ...await run(), success: true })) as typeof statement.run;
    return statement;
  } } as D1Database;
  const executions = new Map<string, { id: string; status: string; stdout: string; stderr: string }>();
  const npm = { lockfile: '{"lockfileVersion":3}' };
  f.env.USER_CONTAINER = { idFromName: (name: string) => name, get: () => ({ async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === '/files') {
      const path = url.searchParams.get('path')!;
      if (request.method === 'GET') return runtime.read(path);
      assert.equal(request.method, 'PUT');
      await runtime.write(path, new Uint8Array(await request.arrayBuffer()));
      return Response.json({ saved: true });
    }
    if (url.pathname === '/executions' && request.method === 'POST') {
      const { command } = await request.json() as { command: string };
      if (command.includes('npm install') && !(await runtime.read('/workspace/app/package-lock.json')).ok)
        await runtime.write('/workspace/app/package-lock.json', npm.lockfile);
      // Git and filesystem commands are real; dependency installation, compilation
      // and the preview process are outside this persistence test's scope.
      const result = command.includes('npm install') || command.includes('tsc --noEmit') || command.includes('tmux ')
        ? { status: 'succeeded', stdout: '', stderr: '' } : await runtime.run('container', command);
      const id = `execution-${executions.size}`, execution = { id, ...result };
      executions.set(id, execution); return Response.json(execution);
    }
    if (url.pathname.startsWith('/executions/')) return Response.json(executions.get(url.pathname.split('/').at(-1)!));
    if (url.pathname === '/previews') return Response.json({ id: crypto.randomUUID().replaceAll('-', ''), token: crypto.randomUUID().replaceAll('-', '').repeat(2).slice(0, 48),
      port: 3000, createdAt: GENERATION_ONE, expiresAt: Date.now() + 30 * 60_000 }, { status: 201 });
    assert.fail(`Unexpected container request: ${request.method} ${url.pathname}`);
  } }) } as unknown as DurableObjectNamespace;

  function editSource(changes: BuildFiles) {
    let round = 0;
    f.env.AI = { async run() {
      const editing = round++ === 0;
      return { choices: [{ finish_reason: editing ? 'tool_calls' : 'stop', message: editing
        ? { tool_calls: Object.entries(changes).map(([path, content], index) => ({ id: `write-${index}`, type: 'function',
          function: { name: 'write_file', arguments: JSON.stringify({ path, content }) } })) } : { content: 'App updated.' } }],
      usage: { prompt_tokens: 5, completion_tokens: 5 } };
    } } as unknown as Ai;
  }
  async function run(params: BuildParams) {
    await runBuildAgent(f.env, params, step as unknown as Parameters<typeof runBuildAgent>[2], Date.now());
  }
  async function cloneRepository(label = 'exported') {
    const response = await handleBuildRequest(request(appId, '/repository'), f.env);
    assert.equal(response.status, 200);
    const bundle = join(disk, `${label}.bundle`), directory = join(disk, label);
    writeFileSync(bundle, new Uint8Array(await response.arrayBuffer()));
    git(['clone', '--quiet', '-b', 'main', bundle, directory], disk);
    git(['fsck', '--full'], directory);
    return directory;
  }
  return { ...f, params, app, turn, startTurn, objects, puts, bucket, disk, localPath, runtime, commands, attempts, dispatched, editSource, run, cloneRepository, npm };
}

function request(appId: string, suffix: string, session = SESSION_ONE, body?: unknown, key = 'restore') {
  return new Request(`https://api.mainbrella.com/build/apps/${appId}${suffix}`, { method: body ? 'POST' : 'GET',
    headers: { Origin: 'https://mainbrella.com', Cookie: `mainbrella_session=${session}`,
      ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
function git(args: string[], cwd: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}

test('R2 versions export valid Git history with lockfiles and referenced images, excluding untracked files', async t => {
  const f = await fixture(t), imageId = crypto.randomUUID(), unusedImageId = crypto.randomUUID();
  const jpeg = Uint8Array.from([255, 216, 255, 217]);
  for (const id of [imageId, unusedImageId]) f.sqlite.prepare('INSERT INTO build_images (id,app_id,turn_id,tool_id,label,prompt,data) VALUES(?,?,?,?,?,?,?)')
    .run(id, f.params.appId, f.params.turnId, id, 'Image', 'Test image', Buffer.from(jpeg).toString('base64'));
  const files = { ...buildStarter, 'src/App.tsx': `export default function App() { return <img src="${buildImagePath(imageId)}" /> }` };
  const lockfile = '{"lockfileVersion":3}';
  await f.runtime.write('/workspace/app/package-lock.json', lockfile);
  await f.runtime.write('/workspace/app/.env', 'PRIVATE_SECRET=ignored');
  await f.runtime.write('/workspace/app/untracked.txt', 'not authored source');
  const version = await saveBuildGitVersion(f.env, f.params, f.runtime, f.turn(f.params), files, true);
  assert.equal(version!.verified, 1); assert.equal(version!.lockfile, lockfile);
  assert.deepEqual(JSON.parse(version!.assets_json), [imageId]);
  assert.equal(f.app().git_version_id, version!.id);
  const clone = await f.cloneRepository();
  assert.equal(git(['rev-parse', 'HEAD'], clone), version!.commit_id);
  assert.equal(readFileSync(join(clone, 'src/App.tsx'), 'utf8'), files['src/App.tsx']);
  assert.equal(readFileSync(join(clone, 'package-lock.json'), 'utf8'), lockfile);
  assert.deepEqual(new Uint8Array(readFileSync(join(clone, `public${buildImagePath(imageId)}`))), jpeg);
  const paths = git(['ls-tree', '-r', '--name-only', 'HEAD'], clone).split('\n');
  assert.ok(!paths.includes(`public${buildImagePath(unusedImageId)}`));
  assert.ok(!paths.includes('.env')); assert.ok(!paths.includes('untracked.txt'));
});

test('lost D1 save acknowledgements retry the persistence callback without duplicating versions or moving the parent', async t => {
  for (const withParent of [false, true]) await t.test(withParent ? 'existing history' : 'first save', async sub => {
    const f = await fixture(sub);
    const parent = withParent ? await saveBuildGitVersion(f.env, f.params, f.runtime, f.turn(f.params), buildStarter, true) : null;
    const params = withParent ? f.startTurn() : f.params;
    const files = { ...buildStarter, 'src/App.tsx': 'export default function App() { return <h1>Saved once</h1> }' };
    const batch = f.env.DB.batch.bind(f.env.DB);
    let batches = 0;
    sub.mock.method(f.env.DB, 'batch', async (statements: D1PreparedStatement[]) => {
      const result = await batch(statements);
      if (++batches === 1) throw new Error('Lost D1 acknowledgement after commit');
      return result;
    });
    const beforeAttempts = f.attempts.get('Persist Git bundle') ?? 0, beforePuts = f.puts.length;
    const version = await saveBuildGitVersion(f.env, params, f.runtime, f.turn(params), files, true);
    assert.equal(f.attempts.get('Persist Git bundle')! - beforeAttempts, 2);
    assert.equal(batches, 1); assert.equal(f.puts.length - beforePuts, 2);
    assert.equal(f.app().git_version_id, params.turnId);
    assert.equal(version!.parent_version_id, parent?.id ?? null);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM build_git_versions').get()!.n, withParent ? 2 : 1);
    const clone = await f.cloneRepository();
    assert.equal(git(['rev-list', '--count', 'HEAD'], clone), withParent ? '2' : '1');
    const beforeCommands = f.commands.length;
    await saveBuildGitVersion(f.env, params, f.runtime, f.turn(params), files, true);
    assert.equal(f.commands.length, beforeCommands); assert.equal(f.puts.length - beforePuts, 2);
  });
});

test('lost R2 part and manifest acknowledgements reconcile immutable uploads before publishing the head', async t => {
  for (const target of ['parts/', 'bundles/']) await t.test(target, async sub => {
    const f = await fixture(sub), put = f.bucket.put.bind(f.bucket);
    let lost = false;
    sub.mock.method(f.bucket, 'put', async (...args: Parameters<typeof put>) => {
      const result = await put(...args);
      assert.equal(f.app().git_version_id, null, 'R2 objects precede the database head');
      if (!lost && args[0].includes(target)) { lost = true; throw new Error('Lost R2 acknowledgement after upload'); }
      return result;
    });
    const version = await saveBuildGitVersion(f.env, f.params, f.runtime, f.turn(f.params), buildStarter, true);
    assert.ok(lost); assert.equal(f.attempts.get('Persist Git bundle'), 2);
    assert.equal(f.objects.size, 2); assert.equal(f.app().git_version_id, version!.id);
    await f.cloneRepository();
  });
});

test('unavailable R2 storage leaves the previous Git head and history intact', async t => {
  const f = await fixture(t);
  const parent = await saveBuildGitVersion(f.env, f.params, f.runtime, f.turn(f.params), buildStarter, true);
  const params = f.startTurn();
  t.mock.method(f.bucket, 'put', async () => { throw new Error('R2 unavailable'); });
  await assert.rejects(saveBuildGitVersion(f.env, params, f.runtime, f.turn(params), { ...buildStarter, 'src/new.ts': 'new file' }, true), /R2 unavailable/);
  assert.equal(f.app().git_version_id, parent!.id);
  assert.equal(await buildGitVersion(f.env, params.appId, params.turnId), null);
  const clone = await f.cloneRepository();
  assert.equal(git(['rev-parse', 'HEAD'], clone), parent!.commit_id);
});

test('fresh container disks hydrate Git from R2 and reject missing or corrupt bundle parts', async t => {
  const f = await fixture(t);
  const version = await saveBuildGitVersion(f.env, f.params, f.runtime, f.turn(f.params), buildStarter, true);
  rmSync(f.disk, { recursive: true }); mkdirSync(f.disk);
  await hydrateBuildGit(f.env, f.params, f.runtime, version, f.turn(f.params));
  const appDirectory = f.localPath('/workspace/app');
  assert.equal(git(['rev-parse', 'HEAD'], appDirectory), version!.commit_id);
  git(['fsck', '--full'], appDirectory);
  const manifest = JSON.parse(new TextDecoder().decode(f.objects.get(version!.bundle_key)!));
  const key = manifest.parts[0].key, original = f.objects.get(key)!;
  f.objects.delete(key);
  await assert.rejects(hydrateBuildGit(f.env, f.params, f.runtime, version, f.turn(f.params)), /build_git_unavailable/);
  const corrupted = original.slice(); corrupted[corrupted.length - 1] ^= 1; f.objects.set(key, corrupted);
  await assert.rejects(hydrateBuildGit(f.env, f.params, f.runtime, version, f.turn(f.params)), /build_git_unavailable/);
  assert.equal(f.app().git_version_id, version!.id);
});

test('a superseded turn cannot publish a Git version after R2 uploads', async t => {
  const f = await fixture(t), put = f.bucket.put.bind(f.bucket);
  let replacement: BuildParams | undefined;
  t.mock.method(f.bucket, 'put', async (...args: Parameters<typeof put>) => {
    const result = await put(...args);
    if (!replacement && args[0].includes('/bundles/')) replacement = f.startTurn();
    return result;
  });
  await assert.rejects(saveBuildGitVersion(f.env, f.params, f.runtime, f.turn(f.params), buildStarter, true), /git_head_conflict/);
  assert.equal(f.app().active_turn_id, replacement!.turnId); assert.equal(f.app().git_version_id, null);
  assert.equal(await buildGitVersion(f.env, f.params.appId, f.params.turnId), null);
});

test('the build workflow succeeds after a lost Git save acknowledgement and checkpoints later failed edits', async t => {
  const f = await fixture(t), batch = f.env.DB.batch.bind(f.env.DB);
  let lost = false;
  t.mock.method(f.env.DB, 'batch', async (statements: D1PreparedStatement[]) => {
    const result = await batch(statements);
    if (!lost && await buildGitVersion(f.env, f.params.appId, f.params.turnId)) {
      lost = true; throw new Error('Lost D1 acknowledgement after Git save');
    }
    return result;
  });
  f.editSource({ 'src/App.tsx': 'export default function App() { return <h1>Working version</h1> }' });
  await f.run(f.params);
  assert.ok(lost); assert.equal(f.turn(f.params).status, 'succeeded');
  assert.equal(f.app().verified_git_version_id, f.params.turnId);
  assert.equal(f.attempts.get('Persist Git bundle'), 2);
  const params = f.startTurn();
  const edited = 'export default function App() { return <h1>Unfinished change</h1> }';
  f.editSource({ 'src/App.tsx': edited });
  const inference = f.env.AI.run.bind(f.env.AI); let calls = 0;
  t.mock.method(f.env.AI, 'run', async (...args: Parameters<typeof inference>) => {
    if (calls++) throw new Error('Model unavailable after editing');
    return inference(...args);
  });
  t.mock.method(console, 'error', () => {});
  await f.run(params);
  assert.equal(f.turn(params).status, 'failed');
  const checkpoint = await buildGitVersion(f.env, params.appId, params.turnId);
  assert.equal(checkpoint!.verified, 0); assert.equal(checkpoint!.parent_version_id, f.params.turnId);
  assert.equal(JSON.parse(checkpoint!.source_json)['src/App.tsx'], edited);
  assert.equal(f.app().git_version_id, params.turnId);
  assert.equal(f.app().verified_git_version_id, f.params.turnId);
  const clone = await f.cloneRepository();
  assert.equal(readFileSync(join(clone, 'src/App.tsx'), 'utf8'), edited);
  assert.equal(git(['rev-list', '--count', 'HEAD'], clone), '2');
});

test('restore rebuilds an older source and lockfile as a new commit, retaining intervening history and idempotency', async t => {
  const f = await fixture(t), original = 'export default function App() { return <h1>Original</h1> }';
  const lockfile = '{"name":"original","lockfileVersion":3}';
  f.npm.lockfile = lockfile;
  f.editSource({ 'src/App.tsx': original });
  await f.run(f.params);
  assert.equal(f.turn(f.params).status, 'succeeded');
  const second = f.startTurn();
  f.editSource({ 'src/App.tsx': 'export default function App() { return <h1>Later</h1> }', 'src/later.ts': 'export const later = true;' });
  await f.run(second);
  assert.equal(f.turn(second).status, 'succeeded');
  t.mock.method(f.env.AI, 'run', async () => { assert.fail('Restoring a version must not call AI'); });
  const body = { versionId: f.params.turnId, revision: f.app().revision };
  const queued = await handleBuildRequest(request(f.params.appId, '/restore', SESSION_ONE, body), f.env);
  assert.equal(queued.status, 202);
  const restoring = { ...f.params, turnId: f.app().active_turn_id! };
  assert.equal(f.dispatched.length, 1);
  assert.equal((await handleBuildRequest(request(f.params.appId, '/restore', SESSION_ONE, body, 'busy'), f.env)).status, 409);
  await f.run(restoring);
  assert.equal(f.turn(restoring).status, 'succeeded');
  const restored = await buildGitVersion(f.env, restoring.appId, restoring.turnId);
  assert.equal(restored!.parent_version_id, second.turnId); assert.equal(restored!.lockfile, lockfile);
  assert.equal(f.app().revision, body.revision + 1); assert.equal(f.app().verified_git_version_id, restored!.id);
  const clone = await f.cloneRepository();
  assert.equal(readFileSync(join(clone, 'src/App.tsx'), 'utf8'), original);
  assert.equal(readFileSync(join(clone, 'package-lock.json'), 'utf8'), lockfile);
  assert.ok(!git(['ls-tree', '-r', '--name-only', 'HEAD'], clone).split('\n').includes('src/later.ts'));
  assert.equal(git(['rev-list', '--count', 'HEAD'], clone), '3');
  assert.equal(git(['rev-parse', 'HEAD^'], clone), (await buildGitVersion(f.env, second.appId, second.turnId))!.commit_id);
  assert.equal((await handleBuildRequest(request(f.params.appId, '/restore', SESSION_ONE, body), f.env)).status, 200);
  assert.equal(f.dispatched.length, 1);
  assert.equal((await handleBuildRequest(request(f.params.appId, '/restore', SESSION_ONE, body, 'stale'), f.env)).status, 409);
  const detail = await (await handleBuildRequest(request(f.params.appId, `/versions/${restored!.id}`), f.env)).json() as { changes: { path: string; type: string }[] };
  assert.ok(detail.changes.some(change => change.path === 'src/later.ts' && change.type === 'deleted'));
});

test('version history, repository exports and restores enforce app ownership and authentication', async t => {
  const f = await fixture(t);
  const version = await saveBuildGitVersion(f.env, f.params, f.runtime, f.turn(f.params), buildStarter, true);
  for (const suffix of ['/versions', `/versions/${version!.id}`, '/repository', '/restore']) {
    const body = suffix === '/restore' ? { versionId: version!.id, revision: 0 } : undefined;
    assert.equal((await handleBuildRequest(request(f.params.appId, suffix, SESSION_TWO, body), f.env)).status, 404);
    assert.equal((await handleBuildRequest(request(f.params.appId, suffix, 'expired-session', body), f.env)).status, 401);
  }
  f.setBillingMode('unpaid');
  for (const suffix of ['/versions', `/versions/${version!.id}`, '/repository'])
    assert.equal((await handleBuildRequest(request(f.params.appId, suffix), f.env)).status, 200, 'Read access survives loss of paid access');
  const manifest = JSON.parse(new TextDecoder().decode(f.objects.get(version!.bundle_key)!));
  manifest.parts[0].key = `build-git/another-user/another-app/parts/${manifest.parts[0].sha256}`;
  f.objects.set(version!.bundle_key, new TextEncoder().encode(JSON.stringify(manifest)));
  assert.equal((await handleBuildRequest(request(f.params.appId, '/repository'), f.env)).status, 503);
});

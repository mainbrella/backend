import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { acceptPreviewObservation, observeRunningWorkspaces } from '../lib/acquisition-sources';
import { accountResponse } from '../lib/container-service';
import { handlePreviewGateway } from '../preview-gateway';
import { previewDatabase } from '../lib/preview-test-helpers';
import { previewTokenHash } from '../lib/preview-routing';

const USER = 'source-user';
const BASE = Date.UTC(2026, 9, 1, 12);
const generation = new Date(BASE).toISOString();

function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  for (const migration of ['001_initial', '013_repo_launches', '021_acquisition', '022_acquisition_sources'])
    sqlite.exec(readFileSync(new URL(`../../migrations/${migration}.sql`, import.meta.url), 'utf8'));
  sqlite.prepare('INSERT INTO users(id,email,name) VALUES (?,?,?)').run(USER, 'dev@example.com', 'Dev');
  t.after(() => sqlite.close());
  type Statement = { sql: string; values: unknown[]; bind(...args: unknown[]): Statement;
    first<T>(): Promise<T | null>; run(): Promise<{ success: boolean; meta: { changes: number } }> };
  const prepare = (sql: string, values: unknown[] = []): Statement => ({
    sql, values, bind(...args) { return prepare(sql, args); },
    async first<T>() { return sqlite.prepare(sql).get(...values as never[]) as T ?? null; },
    async run() { const result = sqlite.prepare(sql).run(...values as never[]);
      return { success: true, meta: { changes: Number(result.changes) } }; },
  });
  const db = { prepare, async batch(statements: Statement[]) {
    sqlite.exec('BEGIN');
    try {
      const result = statements.map(statement => ({
        success: true, meta: { changes: Number(sqlite.prepare(statement.sql).run(...statement.values as never[]).changes) },
      }));
      sqlite.exec('COMMIT'); return result;
    } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } } as unknown as D1Database;
  const env = { DB: db, ACQUISITION_ENABLED: 'true' };
  const events = (type: string) => sqlite.prepare('SELECT * FROM acquisition_events WHERE event_type=? ORDER BY sequence').all(type);
  const save = (id: string, state: Record<string, unknown>) => sqlite.prepare(`INSERT INTO repo_launches
    (id,user_id,idempotency_key,request_json,state_json,created_at) VALUES (?,?,?,'{}',?,?)
    ON CONFLICT(id) DO UPDATE SET state_json=excluded.state_json`).run(id, USER, id, JSON.stringify(state), BASE);
  const launch = (overrides: Record<string, unknown> = {}) => ({
    phase: 'ready', container: { id: 'small', createdAt: generation },
    repository: { repo: 'owner/project', commit: 'a'.repeat(40) },
    options: { setupCommand: 'npm test --secret-do-not-record' },
    executions: { setup: 'execution-1' }, previewReadyAt: null, ...overrides,
  });
  return { sqlite, env, events, save, launch };
}

test('launch state writes atomically record running generations and real setup or HTTP activation', t => {
  const f = fixture(t);
  f.save('clone-only', f.launch({ options: {}, executions: {} }));
  assert.equal(f.events('workspace.started').length, 1);
  assert.equal(f.events('workload.activated').length, 0);
  f.save('setup', f.launch());
  f.save('setup', f.launch());
  assert.equal(f.events('workspace.started').length, 1);
  assert.equal(f.events('workload.activated').length, 1);
  assert.equal(JSON.parse(f.events('workload.activated')[0].payload as string).basis, 'repository_setup_succeeded');
  f.save('web', f.launch({ options: { startCommand: 'private-command' }, executions: { starting: 'execution-2' }, previewReadyAt: BASE }));
  assert.equal(f.events('workload.activated').length, 2);
  assert.equal(JSON.parse(f.events('workload.activated')[1].payload as string).basis, 'http_preview_ready');
  const serialized = JSON.stringify(f.sqlite.prepare('SELECT payload FROM acquisition_events').all());
  assert.ok(!serialized.includes('secret-do-not-record'));
  assert.ok(!serialized.includes('private-command'));
  const running = f.events('workspace.started')[0];
  assert.equal(running.occurred_at, BASE);
  assert.deepEqual(JSON.parse(running.payload as string), { containerId: 'small', createdAt: generation });
});

test('clone and failed setup do not activate; failures retain only safe stage facts', t => {
  const f = fixture(t);
  f.save('failed', f.launch({ phase: 'failed', error: 'setup_failed', logs: 'password=secret' }));
  f.save('failed', f.launch({ phase: 'failed', error: 'setup_failed' }));
  assert.equal(f.events('workload.activated').length, 0);
  assert.equal(f.events('launch.failed').length, 1);
  assert.deepEqual(JSON.parse(f.events('launch.failed')[0].payload as string), {
    launchId: 'failed', repo: 'owner/project', failureStage: 'setup', errorCode: 'setup_failed',
  });
  f.save('unknown-failure', f.launch({ phase: 'failed', error: 'secret-url?token=secret' }));
  assert.equal(JSON.parse(f.events('launch.failed')[1].payload as string).errorCode, 'launch_failed');
  f.sqlite.exec('DROP TABLE acquisition_events');
  assert.throws(() => f.save('rollback', f.launch()), /no such table/);
  assert.equal(f.sqlite.prepare("SELECT id FROM repo_launches WHERE id='rollback'").get(), undefined);
});

test('qualification requires two distinct workloads on different UTC days and tolerates out-of-order facts', t => {
  const f = fixture(t);
  const web = (time: number) => f.launch({ options: {}, previewReadyAt: time });
  f.save('one', web(BASE + 86400000));
  f.save('two', web(BASE + 86400000 + 1000));
  assert.equal(f.events('developer.qualified').length, 0);
  f.save('three', web(BASE));
  assert.equal(f.events('developer.qualified').length, 1);
  assert.equal(f.events('developer.qualified')[0].occurred_at, BASE + 86400000 + 1000);
  f.save('three', web(BASE));
  f.save('four', web(BASE + 2 * 86400000));
  assert.equal(f.events('developer.qualified').length, 1);
  assert.throws(() => f.sqlite.prepare("UPDATE acquisition_events SET payload='{}'").run(), /append_only/);
});

test('private account snapshots record actual running generations once while preserving the response', async t => {
  const f = fixture(t);
  const containers = [
    { id: 'small', createdAt: generation, status: 'running' },
    { id: 'c1', createdAt: generation, status: 'starting' },
  ];
  const env = { ...f.env, USER_CONTAINER: {}, CONTAINER_ACCOUNT: {
    idFromName(name: string) { assert.equal(name, `account:${USER}`); return name; },
    get() { return { fetch() { return Response.json({ containers }); } }; },
  } } as unknown as Env;
  const response = await accountResponse(env, USER, { active: true, plan: 'prepaid' } as never);
  assert.deepEqual(await response.json(), { containers });
  await observeRunningWorkspaces(env, USER, containers);
  f.save('same-generation', f.launch());
  assert.equal(f.events('workspace.started').length, 1);
  await observeRunningWorkspaces(env, USER, [{ id: 'small', status: 'running', createdAt: new Date(BASE + 1000).toISOString() }]);
  assert.equal(f.events('workspace.started').length, 2);
  await observeRunningWorkspaces({ ...env, ACQUISITION_ENABLED: 'false' }, USER,
    [{ id: 'c1', status: 'running', createdAt: generation }]);
  assert.equal(f.events('workspace.started').length, 2);
});

test('preview opens require a successful HTML document and dedupe without storing bearer URLs', async t => {
  const f = fixture(t);
  const previewSqlite = new DatabaseSync(':memory:');
  t.after(() => previewSqlite.close());
  const token = 'a'.repeat(48), previewId = 'b'.repeat(32);
  const routes = previewDatabase(previewSqlite);
  previewSqlite.prepare('INSERT INTO preview_routes VALUES (?,?,?,?,?)')
    .run(await previewTokenHash(token), previewId, `user:${USER}:slot:1`, generation, Date.now() + 60000);
  let status = 200, contentType = 'text/html; charset=utf-8';
  const env = { ...f.env, PREVIEWS_ENABLED: 'true', PREVIEW_DOMAIN: 'preview.example', PREVIEW_ROUTES: routes,
    CONTAINER_ACCOUNT: {
      idFromName(name: string) { assert.equal(name, `account:${USER}`); return name; },
      get() { return { fetch(request: Request) {
        assert.equal(request.url, 'https://internal/acquisition/preview-observed');
        return acceptPreviewObservation(request, { ...f.env, PREVIEW_ROUTES: routes }, USER);
      } }; },
    } as unknown as DurableObjectNamespace,
    USER_CONTAINER: { idFromName(name: string) { return name; },
      get() { return { fetch() { return new Response('application', { status, headers: { 'content-type': contentType } }); } }; },
    } as unknown as DurableObjectNamespace,
  };
  const request = (dest: string, method = 'GET') => new Request(`https://${token}.preview.example/?private=secret`,
    { method, headers: { 'sec-fetch-dest': dest, cookie: 'private-cookie' } });
  await handlePreviewGateway(request(''), env);
  await handlePreviewGateway(request('empty'), env);
  status = 500; await handlePreviewGateway(request('document'), env);
  status = 200; contentType = 'application/javascript'; await handlePreviewGateway(request('document'), env);
  contentType = 'text/html'; await handlePreviewGateway(request('document', 'HEAD'), env);
  assert.equal(f.events('preview.opened').length, 0);
  const response = await handlePreviewGateway(request('document'), env);
  assert.equal(await response.text(), 'application');
  await handlePreviewGateway(request('iframe'), env);
  assert.equal(f.events('preview.opened').length, 1);
  const event = f.events('preview.opened')[0];
  assert.equal(event.user_id, USER);
  assert.deepEqual(JSON.parse(event.payload as string), { previewId, containerId: 'c1', createdAt: generation });
  assert.ok(!JSON.stringify(event).includes(token));
  assert.ok(!JSON.stringify(event).includes('secret'));
});


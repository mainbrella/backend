import type test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { Miniflare, Response as MfResponse, convertV4MiniflareOptions } from 'miniflare';
import { hashToken } from '../app/auth-core';

export async function runtime(t: test.TestContext, bindings: Record<string, string> = {}) {
  const bundle = await build({ stdin: { contents: `import { handleBffRequest } from './routes'; import { cleanupBffDatabases } from './maintenance'; import { handleAPIKeysRequest } from '../app/api-keys'; export default { async fetch(request,env) { const path=new URL(request.url).pathname; if(path==='/__test_cleanup') {await cleanupBffDatabases(env);return new Response('ok')} if(path.startsWith('/api-keys')) return handleAPIKeysRequest(request,env); return handleBffRequest(request,env); } };`, resolveDir: fileURLToPath(new URL('.', import.meta.url)) },
    bundle: true, write: false, format: 'esm', target: 'es2022', platform: 'browser', external: ['cloudflare:*', 'node:*'] });
  const databases = new Map<string, { name: string; db: DatabaseSync }>();
  const calls: { path: string; body: any }[] = [];
  const outboundTargets: string[] = [];
  let failCreateResponse = false;
  let redirectQuery = false;
  let failDelete = false;
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'bff-test', modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'], workerLoaders: { BFF_LOADER: {} },
    ratelimits: { EMAIL_AUTH_LIMIT: { namespace_id: '1002', simple: { limit: 20, period: 60 } } },
    bindings: { BFF_ENABLED: 'true', BFF_CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), BFF_CLOUDFLARE_API_TOKEN: 'platform-token-must-never-leak', PLATFORM_SECRET: 'platform-secret-must-never-leak', ...bindings },
    // Local-provider tests exercise workerd's real loopback fetch path.
    outboundService: bindings.BFF_LOCAL_URL ? undefined : async request => {
      const url = new URL(request.url);
      outboundTargets.push(url.origin);
      assert.equal(url.origin, 'https://api.cloudflare.com', 'Customer egress must never reach the parent outbound service');
      assert.equal(request.headers.get('authorization'), 'Bearer platform-token-must-never-leak');
      const input = request.method === 'POST' ? await request.json() as any : null;
      calls.push({ path: url.pathname, body: input });
      const response = (result: unknown, success = true) => new MfResponse(JSON.stringify({ success, result }), { status: success ? 200 : 400, headers: { 'content-type': 'application/json' } });
      if (request.method === 'GET') return response([...databases].map(([uuid, { name }]) => ({ uuid, name })).filter(row => row.name === url.searchParams.get('name')));
      if (request.method === 'DELETE') {
        if (failDelete) { failDelete = false; return response(null, false); }
        const id = url.pathname.split('/').at(-1)!;
        databases.get(id)?.db.close(); databases.delete(id); return response(null);
      }
      if (!url.pathname.endsWith('/query')) {
        const id = crypto.randomUUID(); databases.set(id, { name: input.name, db: new DatabaseSync(':memory:') });
        if (failCreateResponse) { failCreateResponse = false; return response(null, false); }
        return response({ uuid: id });
      }
      const id = url.pathname.split('/').at(-2)!;
      if (redirectQuery) { redirectQuery = false; return new MfResponse(null, { status: 302, headers: { location: 'https://evil.example' } }); }
      const db = databases.get(id)!.db;
      try {
        db.exec('BEGIN');
        const results = input.batch.map(({ sql, params = [] }: { sql: string; params?: any[] }) => {
          const statement = db.prepare(sql), results = statement.all(...params);
          return { success: true, results, meta: { changes: Number(db.prepare('SELECT changes() AS n').get()!.n) } };
        });
        db.exec('COMMIT'); return response(results);
      } catch {
        db.exec('ROLLBACK'); return response(null, false);
      }
    },
  }] }));
  t.after(async () => { await mf.dispose(); for (const { db } of databases.values()) db.close(); });
  const db = await mf.getD1Database('DB');
  for (const migration of ['001_initial', '002_auth_sessions', '010_api_keys', '050_bff', '051_bff_api_keys', '052_bff_shared_api_keys', '053_bff_table_policies', '054_bff_message_board', '055_bff_public_demo', '056_bff_email_accounts']) {
    const sql = readFileSync(new URL(`../../migrations/${migration}.sql`, import.meta.url), 'utf8').replace(/^--.*$/gm, '');
    for (const statement of sql.match(/\s*CREATE TRIGGER[\s\S]*?END;|\s*[^;]+;/g) || []) await db.prepare(statement.trim()).run();
  }
  for (const id of ['owner', 'stranger']) {
    await db.prepare('INSERT INTO users(id,email,name) VALUES(?,?,?)').bind(id, `${id}@example.com`, id).run();
    await db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(await hashToken(id), id, '2099-01-01').run();
  }
  const request = (path: string, method = 'GET', body?: unknown, user = 'owner', headers: Record<string, string> = {}) => mf.dispatchFetch(`https://api.mainbrella.com/bff${path}`, {
    method, headers: { cookie: `mainbrella_session=${user}`, origin: 'https://mainbrella.com', 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  async function json(path: string, method = 'GET', body?: unknown, status = 200) {
    const result = await request(path, method, body);
    assert.equal(result.status, status, await result.clone().text());
    return result.json() as Promise<any>;
  }
  return { mf, db, request, json, databases, calls, outboundTargets,
    loseCreateResponse() { failCreateResponse = true; }, redirectNextQuery() { redirectQuery = true; }, failNextDelete() { failDelete = true; } };
}


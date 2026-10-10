import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleRequest } from './router';
import { hashToken } from './auth-core';
import { appendProductEvent, appendProductEventsWithCursor } from '../lib/acquisition';

const USER = 'acq-user', ADMIN = 'acq-admin', SESSION = 'acq-session', ADMIN_SESSION = 'acq-admin-session';
async function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:');
  for (const migration of ['001_initial.sql','002_auth_sessions.sql','020_accounting_ledger.sql','021_acquisition.sql'])
    sqlite.exec(readFileSync(new URL(`../../migrations/${migration}`, import.meta.url), 'utf8'));
  sqlite.prepare('INSERT INTO users(id,email,name) VALUES(?,?,?)').run(USER,'dev@example.com','Dev');
  sqlite.prepare('INSERT INTO users(id,email,name) VALUES(?,?,?)').run(ADMIN,'oneone@gmail.com','Admin');
  for (const [token,id] of [[SESSION,USER],[ADMIN_SESSION,ADMIN]])
    sqlite.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(await hashToken(token),id,'2099-01-01');
  const db = {
    prepare(sql: string) {
      let values: unknown[] = [];
      return {
        bind(...args: unknown[]) { values = args; return this; },
        async first<T>() { return (sqlite.prepare(sql).get(...values as never[]) as T) ?? null; },
        async all<T>() { return { results: sqlite.prepare(sql).all(...values as never[]) as T[] }; },
        async run() { const result=sqlite.prepare(sql).run(...values as never[]); return { meta:{changes:Number(result.changes)} }; },
      };
    },
    async batch(statements: any[]) {
      sqlite.exec('BEGIN');
      try {
        const result = statements.map(statement => {
          const sql = (statement as any).sql;
          const values = (statement as any).values;
          const row = sqlite.prepare(sql).run(...values as never[]);
          return { meta: { changes: Number(row.changes) } };
        });
        sqlite.exec('COMMIT');
        return result;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  // Capture the SQL/bind values for D1 batch from the wrapper.
  db.prepare = ((sql: string) => {
    let values: unknown[] = [];
    return { sql, get values() { return values; }, bind(...args: unknown[]) { values = args; return this; },
      async first<T>() { return (sqlite.prepare(sql).get(...values as never[]) as T) ?? null; },
      async all<T>() { return { results: sqlite.prepare(sql).all(...values as never[]) as T[] }; },
      async run() { const result=sqlite.prepare(sql).run(...values as never[]); return { meta:{changes:Number(result.changes)} }; } } as any;
  }) as typeof db.prepare;
  const env = { DB: db, ACQUISITION_ENABLED: 'true', LOCAL_DEV: 'true', ACQUISITION_SUBMISSION_LIMIT: {
    async limit() { return { success: true }; },
  } } as unknown as Env;
  t.after(() => sqlite.close());
  return { sqlite, env };
}
function apiRequest(path: string, method: string, body?: unknown, session?: string, origin: string | null = 'https://mainbrella.com') {
  const headers = new Headers();
  if (origin) headers.set('Origin', origin);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  headers.set('CF-Connecting-IP', '192.0.2.11');
  if (session) headers.set('Cookie', `mainbrella_session=${session}`);
  return new Request(`https://api.mainbrella.com${path}`, { method, headers, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
}
const input = (token: string, repo = 'owner/repo') => ({ token, repo, attribution: { entryPage: '/try/', utm_campaign: 'fall_test' } });

test('public repository submission verifies once, stores only a token hash, and links immutable first-touch attribution', async t => {
  const { sqlite, env } = await fixture(t);
  let githubCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => { githubCalls++; return Response.json({ private: false, disabled: false, full_name: 'Owner/Repo', default_branch: 'main' }); });
  const token = 'a'.repeat(64);
  const create = await handleRequest(apiRequest('/acquisition/repositories','POST',input(token)),env);
  assert.equal(create.status,201, JSON.stringify(await create.clone().json()));
  const created = await create.json() as { leadId: string; repo: string };
  assert.equal(created.repo,'Owner/Repo');
  assert.equal((await handleRequest(apiRequest('/acquisition/repositories','POST',input(token)),env)).status,200);
  assert.equal(githubCalls,1);
  assert.equal((await handleRequest(apiRequest('/acquisition/repositories','POST',input(token,'different/repo')),env)).status,409);
  assert.equal((await handleRequest(apiRequest('/acquisition/repositories','POST',{...input('b'.repeat(64)),accountId:USER}),env)).status,400);
  assert.equal((await handleRequest(apiRequest('/acquisition/repositories','POST',JSON.stringify({ ...input('d'.repeat(64)), extra:'x'.repeat(5000) })),env)).status,413);
  assert.equal((await handleRequest(apiRequest('/acquisition/repositories','POST',input('c'.repeat(64)),undefined,null),env)).status,403);
  assert.equal((sqlite.prepare('SELECT token_hash,repo FROM acquisition_leads WHERE id=?').get(created.leadId) as any).token_hash, await hashToken(token));
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS n FROM acquisition_events WHERE event_type='repo.submitted'").get() as any).n,1);
  assert.equal((await handleRequest(apiRequest('/acquisition/link','POST',{token},SESSION),env)).status,200);
  assert.equal((await handleRequest(apiRequest('/acquisition/link','POST',{token},SESSION),env)).status,200);
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS n FROM acquisition_events WHERE event_type='lead.captured'").get() as any).n,1);
  assert.equal((sqlite.prepare('SELECT lead_id FROM acquisition_accounts WHERE user_id=?').get(USER) as any).lead_id,created.leadId);
  await appendProductEvent(env,{key:'workload:one',type:'workload.activated',userId:USER,occurredAt:Date.now(),data:{launchId:'one'}});
  assert.equal((sqlite.prepare("SELECT lead_id FROM acquisition_events WHERE event_key='workload:one'").get() as any).lead_id,created.leadId);
  const secondToken = 'e'.repeat(64);
  const second = await (await handleRequest(apiRequest('/acquisition/repositories','POST',input(secondToken)),env)).json() as any;
  assert.equal((await handleRequest(apiRequest('/acquisition/link','POST',{token:secondToken},SESSION),env)).status,200);
  assert.equal((sqlite.prepare('SELECT lead_id FROM acquisition_accounts WHERE user_id=?').get(USER) as any).lead_id,created.leadId);
  const adminEvents = await (await handleRequest(apiRequest('/admin/acquisition/events?userId=acq-user&event=repo.submitted','GET',undefined,ADMIN_SESSION),env)).json() as any;
  assert.equal(adminEvents.events[0].userId,USER);
  assert.ok(adminEvents.events[0].attribution);
  const signup = await (await handleRequest(apiRequest('/admin/acquisition/events?userId=acq-user&event=user.created','GET',undefined,ADMIN_SESSION),env)).json() as any;
  assert.equal(signup.events.length,1);
  assert.equal(signup.events[0].leadId,created.leadId);
  assert.ok(signup.events[0].attribution);
  const adminLeads = await (await handleRequest(apiRequest('/admin/acquisition/leads','GET',undefined,ADMIN_SESSION),env)).text();
  assert.ok(!adminLeads.includes('token_hash'));
  assert.throws(()=>sqlite.prepare('UPDATE acquisition_leads SET attribution_json=? WHERE id=?').run('{}',created.leadId),/immutable/);
  assert.throws(()=>sqlite.prepare('DELETE FROM acquisition_events').run(),/append_only/);
});

test('event append cursor uses compare-and-set and admin acquisition reads require the admin session', async t => {
  const { sqlite, env } = await fixture(t);
  const adminGet = (path: string, session?: string) => handleRequest(apiRequest(path,'GET',undefined,session),env);
  assert.equal((await adminGet('/admin/acquisition/leads',SESSION)).status,403);
  assert.equal((await adminGet('/admin/acquisition/leads',ADMIN_SESSION)).status,200);
  const event = { key:'paid:source:1', type:'wallet.funded_paid' as const, userId:USER, occurredAt:Date.now(), data:{ cents:500 } };
  assert.equal(await appendProductEventsWithCursor(env,USER,0,4,[event]),true);
  assert.equal(await appendProductEventsWithCursor(env,USER,0,8,[{...event,key:'paid:source:2'}]),false);
  assert.equal((sqlite.prepare('SELECT through_sequence FROM acquisition_projection_accounts WHERE user_id=?').get(USER) as any).through_sequence,4);
  assert.equal((sqlite.prepare('SELECT COUNT(*) AS n FROM acquisition_events WHERE event_key LIKE \'paid:%\'').get() as any).n,1);
  const page = await (await adminGet('/admin/acquisition/events?event=wallet.funded_paid',ADMIN_SESSION)).json() as any;
  assert.equal(page.events[0].type,'wallet.funded_paid');
  assert.equal(page.events[0].attribution,null);
  assert.equal((await adminGet('/admin/acquisition/events?limit=101',ADMIN_SESSION)).status,400);
});

test('cursor batches abort on mismatched event keys and allow exact retries at a later watermark', async t => {
  const { sqlite, env } = await fixture(t);
  const at = Date.now();
  sqlite.prepare('INSERT INTO acquisition_projection_accounts(user_id,through_sequence) VALUES(?,0)').run(USER);
  sqlite.prepare(`INSERT INTO acquisition_events(event_key,event_type,user_id,occurred_at,recorded_at,payload)
    VALUES(?,?,?,?,?,?)`).run('collision:existing','wallet.funded_paid',USER,at,at,'{"cents":100}');
  const mismatched = [
    { key:'new:before-collision', type:'wallet.funded_paid' as const, userId:USER, occurredAt:at, data:{ cents:10 } },
    { key:'collision:existing', type:'wallet.funded_paid' as const, userId:USER, occurredAt:at, data:{ cents:500 } },
  ];
  await assert.rejects(appendProductEventsWithCursor(env,USER,0,10,mismatched),/append_only/);
  assert.equal((sqlite.prepare('SELECT through_sequence FROM acquisition_projection_accounts WHERE user_id=?').get(USER) as any).through_sequence,0);
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS n FROM acquisition_events WHERE event_key='new:before-collision'").get() as any).n,0);
  assert.equal((sqlite.prepare("SELECT payload FROM acquisition_events WHERE event_key='collision:existing'").get() as any).payload,'{"cents":100}');

  sqlite.prepare(`INSERT INTO acquisition_events(event_key,event_type,user_id,occurred_at,recorded_at,payload)
    VALUES(?,?,?,?,?,?)`).run('retry:existing','wallet.funded_paid',USER,at,at,'{"cents":500}');
  const exact = [{ key:'retry:existing', type:'wallet.funded_paid' as const, userId:USER, occurredAt:at, data:{ cents:500 } }];
  assert.equal(await appendProductEventsWithCursor(env,USER,0,10,exact),true);
  assert.equal(await appendProductEventsWithCursor(env,USER,10,20,exact),true);
  assert.equal((sqlite.prepare('SELECT through_sequence FROM acquisition_projection_accounts WHERE user_id=?').get(USER) as any).through_sequence,20);
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS n FROM acquisition_events WHERE event_key='retry:existing'").get() as any).n,1);
});

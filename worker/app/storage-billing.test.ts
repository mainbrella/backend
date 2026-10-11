import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { paidContainerFixture, USER_ONE, USER_TWO, SESSION_ONE } from './paid-container-test-helpers';
import { buildBillingFixture } from './build-billing-test-helpers';
import { dailyStorageCost, finalizeStorageDay, runStorageBilling, settleStorageReceipts, reconcileStorageInvoice, allocateStorageCategory, storageBillingSummary } from '../lib/r2-billing';
import { putStoredObject, getStoredObject, deleteStoredObjects, inventoryObject, PLATFORM_STORAGE, reserveStorage, STORAGE_DAY_MS } from '../lib/r2-storage';
import { notifyStorageRetention, markStorageWarning } from '../lib/r2-retention';
import { storageReadAccess } from '../lib/r2-access';
import { checkStorageHealth } from '../lib/r2-health';
import { cleanupStorageOrphans, expireUnfundedStorage } from '../lib/r2-maintenance';
import { storeBuildSource, storeBuildObject } from '../lib/build-storage';
import { handleRequest } from './router';
import { handleAppDelete } from './auth-app';
import { hashToken } from './auth-core';
import { cleanupDeletedBuildGit } from '../lib/build-git';

async function fixture(t: TestContext, mode: 'meter' | 'charge' = 'meter') {
  let now = Date.UTC(2026, 9, 1, 12);
  t.mock.method(Date, 'now', () => now);
  const f = await paidContainerFixture(t); t.after(f.close);
  for (const file of ['023_build', '024_build_activity', '025_build_images', '027_build_model_effort', '028_build_operations', '029_remove_build_daily_limit', '030_build_git'])
    f.sqlite.exec(readFileSync(new URL(`../../migrations/${file}.sql`, import.meta.url), 'utf8'));
  const billing = await buildBillingFixture(f.env, f.sqlite, USER_ONE);
  f.env.R2_BILLING_MODE = mode;
  f.env.R2_CHARGE_FROM = '2026-10-01T00:00:00Z';
  f.env.DB.batch = (async (statements: D1PreparedStatement[]) => {
    f.sqlite.exec('BEGIN');
    try { const result = []; for (const statement of statements) result.push(await statement.run()); f.sqlite.exec('COMMIT'); return result; }
    catch (error) { f.sqlite.exec('ROLLBACK'); throw error; }
  }) as D1Database['batch'];
  const owner = { userId: USER_ONE, appId: 'app-one' };
  const app = (appId = owner.appId, userId = USER_ONE, source = '{}') => f.sqlite.prepare(`INSERT INTO build_apps(id,user_id,create_key,initial_prompt,name,source_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`)
    .run(appId, userId, appId, 'Test', 'Example app', source, new Date(now).toISOString(), new Date(now).toISOString());
  f.sqlite.prepare("INSERT INTO r2_meter_state(id,value) VALUES('inventory_complete',?)").run(String(now));
  if (mode === 'charge') f.sqlite.prepare("INSERT INTO r2_meter_state(id,value) VALUES('billing_activated_at',?)").run(String(Date.UTC(2026,9,1)));
  const key = (suffix: string) => `build-git/${USER_ONE}/${owner.appId}/objects/${suffix}`;
  return { ...f, ...billing, owner, key, app, now: () => now, advance(ms: number) { now += ms; }, setNow(at: number) { now = at; } };
}

test('physical keys are unique, quota includes all apps, and repeated R2 requests remain separate operation evidence', async t => {
  const f = await fixture(t); f.env.R2_ACCOUNT_MAX_BYTES = '10';
  await putStoredObject(f.env, f.owner, f.key('one'), new Uint8Array(6), 'source');
  await putStoredObject(f.env, f.owner, f.key('one'), new Uint8Array(6), 'source', { onlyIf: { etagDoesNotMatch: '*' } });
  const other = { ...f.owner, appId: 'app-two' };
  await assert.rejects(putStoredObject(f.env, other, `build-git/${USER_ONE}/app-two/objects/two`, new Uint8Array(5), 'source'), /storage_limit_exceeded/);
  assert.equal(f.storage.puts.length, 2);
  assert.equal(f.sqlite.prepare('SELECT SUM(size) AS bytes FROM r2_objects WHERE deleted_at IS NULL').get()!.bytes, 6);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM r2_operations WHERE category='a'").get()!.n, 2);
  await deleteStoredObjects(f.env, f.owner, [f.key('one')]);
  await putStoredObject(f.env, other, `build-git/${USER_ONE}/app-two/objects/two`, new Uint8Array(5), 'source');
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM r2_operations WHERE category='free'").get()!.n, 1);
});

test('short-lived uploads use daily peaks, retained bytes carry across days and metering never debits', async t => {
  const f = await fixture(t);
  await inventoryObject(f.env, f.owner, f.key('large'), 1000000000000, 'history');
  await deleteStoredObjects(f.env, f.owner, [f.key('large')]);
  await inventoryObject(f.env, f.owner, f.key('small'), 1000000000, 'source');
  f.advance(STORAGE_DAY_MS);
  await finalizeStorageDay(f.env, '2026-10-01');
  assert.equal(f.sqlite.prepare('SELECT peak_bytes FROM r2_daily_usage').get()!.peak_bytes, 1000000000000);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM r2_receipts').get()!.n, 0);
  f.advance(STORAGE_DAY_MS);
  await finalizeStorageDay(f.env, '2026-10-02');
  assert.equal(f.sqlite.prepare("SELECT peak_bytes FROM r2_daily_usage WHERE day='2026-10-02'").get()!.peak_bytes, 1000000000);
  assert.deepEqual(dailyStorageCost(1000000000000, 0, 0, 2000), { providerNanoUsd: 500000000, costNanoUsd: 600000000 });
});

test('daily charges retry a lost wallet acknowledgement without double debit and preserve sub-micro-dollar reads', async t => {
  const f = await fixture(t, 'charge');
  await getStoredObject(f.env, f.owner, f.key('missing'));
  f.advance(STORAGE_DAY_MS);
  await finalizeStorageDay(f.env, '2026-10-01');
  const get = f.env.CONTAINER_ACCOUNT.get.bind(f.env.CONTAINER_ACCOUNT); let lost = false;
  f.env.CONTAINER_ACCOUNT.get = ((id: DurableObjectId) => {
    const stub = get(id);
    return { async fetch(request: Request) { const result = await stub.fetch(request); if (!lost) { lost = true; throw new Error('lost_ack'); } return result; } };
  }) as typeof f.env.CONTAINER_ACCOUNT.get;
  await settleStorageReceipts(f.env);
  assert.equal(f.sqlite.prepare('SELECT settled FROM r2_receipts').get()!.settled, 0);
  await settleStorageReceipts(f.env);
  await settleStorageReceipts(f.env);
  const state = f.stored.get('containerAccount') as { wallet: { usedStorageNanoUsd: number } };
  assert.equal(state.wallet.usedStorageNanoUsd, 432);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM accounting_ledger WHERE event_type='storage'").get()!.n, 1);
  assert.equal(f.sqlite.prepare('SELECT settled FROM r2_receipts').get()!.settled, 1);
});

test('writes require a funded retention hold and insufficient funding cannot extend the paid export deadline', async t => {
  const f = await fixture(t, 'charge');
  await inventoryObject(f.env, f.owner, f.key('retained'), 1000000000, 'history');
  const first = await reserveStorage(f.env, USER_ONE); assert.equal(first!.writesBlocked, false);
  const state = f.stored.get('containerAccount') as { spendLimitCents: number; wallet: { usedUnitMs: number; storageHold: { remainingNanoUsd: number } } };
  assert.ok(state.wallet.storageHold.remainingNanoUsd > 0);
  state.wallet.usedUnitMs = 499.9 * 1800000; f.stored.set('containerAccount', state);
  f.advance(STORAGE_DAY_MS);
  const second = await reserveStorage(f.env, USER_ONE);
  assert.equal(second!.writesBlocked, true); assert.equal(second!.fundedThrough, first!.fundedThrough);
  await assert.rejects(putStoredObject(f.env, f.owner, f.key('new'), new Uint8Array(10), 'source'), /storage_funding_required/);
  assert.equal(f.storage.puts.length, 0);
});

test('cron catch-up and actual invoices allocate free tier/rounding proportionally, including Mainbrella, with immutable adjustments', async t => {
  const f = await fixture(t, 'charge');
  await inventoryObject(f.env, f.owner, f.key('retained'), 1000000000, 'history');
  await inventoryObject(f.env, PLATFORM_STORAGE, 'platform/data', 1000000000, 'platform');
  f.setNow(Date.UTC(2026, 10, 2, 12));
  for (let i = 0; i < 5; i++) await runStorageBilling(f.env);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM r2_daily_usage WHERE day LIKE '2026-10-%'").get()!.n, 62);
  const invoice = { id: 'invoice_october', month: '2026-10', evidenceReference: 'cloudflare-invoice-2026-10',
    providerNanoUsd: { storage: 30000000, classA: 0, classB: 0 }, additionalPlatformUsage: { byteDays: 0, classA: 0, classB: 0 } };
  const result = await reconcileStorageInvoice(f.env, invoice);
  assert.equal(result.platformNanoUsd, 15000000);
  assert.equal(result.allocations[0].costNanoUsd, 18000000);
  assert.deepEqual(await reconcileStorageInvoice(f.env, invoice), result);
  await assert.rejects(reconcileStorageInvoice(f.env, { ...invoice, evidenceReference: 'different' }), /storage_invoice_conflict/);
  await settleStorageReceipts(f.env);
  const state = f.stored.get('containerAccount') as { wallet: { usedStorageNanoUsd: number } };
  assert.equal(state.wallet.usedStorageNanoUsd, 18600000); // Includes November 1 retention.
  assert.deepEqual(allocateStorageCategory(2, [1, 1, 1]), [1, 1, 0]);
});

test('orphan cleanup keeps historical manifests and their files while collecting failed partial uploads', async t => {
  const f = await fixture(t);
  const source = await storeBuildSource(f.env, f.owner, { 'index.html': 'kept history' }); f.app('app-one', USER_ONE, source);
  const orphan = await storeBuildObject(f.env, f.owner, new TextEncoder().encode('failed upload'));
  const before = f.storage.objects.size;
  f.advance(2 * STORAGE_DAY_MS);
  await cleanupStorageOrphans(f.env);
  assert.equal(f.storage.objects.has(orphan.$r2), false);
  assert.equal(f.storage.objects.size, before - 1);
  const saved = JSON.parse(source); assert.ok(f.storage.objects.has(saved.$r2));
  assert.equal(f.sqlite.prepare('SELECT SUM(size) AS bytes FROM r2_objects WHERE state=\'live\' AND deleted_at IS NULL').get()!.bytes,
    [...f.storage.objects.values()].reduce((sum, bytes) => sum + bytes.length, 0));
});

test('expired paid retention fences builds, clears references and queues durable physical cleanup', async t => {
  const f = await fixture(t, 'charge'); f.app();
  await inventoryObject(f.env, f.owner, f.key('retained'), 1000000, 'source');
  const state = f.stored.get('containerAccount') as { wallet: { usedUnitMs: number } };
  state.wallet.usedUnitMs = 500 * 1800000; f.stored.set('containerAccount', state);
  f.sqlite.prepare('UPDATE r2_accounts SET funded_through=?,writes_blocked=1,delete_after=?,warned_at=? WHERE user_id=?').run(f.now() - 1, f.now() - 1, f.now() - 31 * STORAGE_DAY_MS, USER_ONE);
  await expireUnfundedStorage(f.env);
  assert.equal(f.sqlite.prepare('SELECT user_id FROM build_git_deletions').get()!.user_id, USER_ONE);
  assert.equal(f.sqlite.prepare('SELECT source_json FROM build_apps').get()!.source_json, '{}');
  await assert.rejects(putStoredObject(f.env, f.owner, f.key('late'), new Uint8Array(1), 'source'), /storage_retention_expired/);
});

test('storage API is owner-scoped, invoice writes require admin and trusted Origin, and markup is configurable', async t => {
  const f = await fixture(t); f.app(); f.app('app-two', USER_TWO);
  await inventoryObject(f.env, f.owner, f.key('retained'), 1000000000, 'source');
  await inventoryObject(f.env, { userId: USER_TWO, appId: 'app-two' }, `build-git/${USER_TWO}/app-two/objects/retained`, 2000000000, 'history');
  const request = (path: string, cookie = true) => new Request(`https://api.mainbrella.com${path}`, { headers: { Origin: 'https://mainbrella.com', ...(cookie ? { Cookie: `mainbrella_session=${SESSION_ONE}` } : {}) } });
  assert.equal((await handleRequest(request('/billing/storage', false), f.env)).status, 401);
  const response = await handleRequest(request('/billing/storage'), f.env); assert.equal(response.status, 200);
  const result = await response.json() as { projects: { appId: string; estimatedMonthlyCents: number }[] };
  assert.equal(result.projects.length, 1); assert.equal(result.projects[0].appId, f.owner.appId);
  assert.ok(Math.abs(result.projects[0].estimatedMonthlyCents - 1.8) < 1e-10);
  assert.equal((await handleRequest(request('/admin/accounting/storage-invoices'), f.env)).status, 403);
  f.env.R2_MARKUP_BPS = '5000';
  assert.equal((await storageBillingSummary(f.env, USER_ONE)).projects[0].estimatedMonthlyCents, 2.25);
});

test('native account deletion atomically queues Git cleanup before cascading project removal and retains financial evidence', async t => {
  const f = await fixture(t); f.sqlite.exec('PRAGMA foreign_keys=ON'); f.app();
  f.sqlite.exec(readFileSync(new URL('./fixtures/legacy-compatibility.sql', import.meta.url), 'utf8'));
  for (const [table, columns] of Object.entries({
    user_linked_accounts: 'user_id TEXT,provider TEXT,linked_at TEXT',
    herd_direct_messages: 'sender_id TEXT,recipient_id TEXT,image_path TEXT',
    subherd_neigh_replies: 'user_id TEXT', subherd_neighs: 'user_id TEXT', subherds: 'created_by TEXT',
    chat_message_reports: 'reporting_user_id TEXT,reported_user_id TEXT',
    herd_member_endorsements: 'endorser_user_id TEXT,endorsed_user_id TEXT',
    herd_meetup_confirmations: 'member_one_user_id TEXT,member_two_user_id TEXT', herd_member_presence: 'user_id TEXT',
    herd_push_notification_state: 'user_id TEXT', push_notification_events: 'target_user_id TEXT,actor_id TEXT',
    community_typicorn_slots: 'user_id TEXT', blocked_users: 'blocking_user_id TEXT,blocked_user_id TEXT',
    herd_media_subscriptions: 'sponsor_user_id TEXT',
  })) f.sqlite.exec(`CREATE TABLE ${table}(${columns})`);
  f.sqlite.exec('ALTER TABLE herds ADD COLUMN media_subscription_sponsor_id TEXT');
  const token = 'a'.repeat(64);
  f.sqlite.prepare('INSERT INTO app_access_tokens(token_hash,user_id,expires_at) VALUES(?,?,?)').run(await hashToken(token), USER_ONE, '2099-01-01');
  await putStoredObject(f.env, f.owner, f.key('retained'), new Uint8Array(10), 'source');
  const before = f.sqlite.prepare('SELECT COUNT(*) AS n FROM accounting_ledger').get()!.n;
  const response = await handleAppDelete(new Request('https://api.mainbrella.com/auth/app/me', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }), f.env, {});
  assert.equal(response.status, 200);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM users WHERE id=?').get(USER_ONE)!.n, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM build_apps WHERE user_id=?').get(USER_ONE)!.n, 0);
  assert.equal(f.sqlite.prepare('SELECT user_id FROM build_git_deletions').get()!.user_id, USER_ONE);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM accounting_ledger').get()!.n, before);
  await cleanupDeletedBuildGit(f.env);
  assert.equal(f.storage.objects.size, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM build_git_deletions').get()!.n, 0);
});

async function unfund(f: Awaited<ReturnType<typeof fixture>>) {
  const state = f.stored.get('containerAccount') as { wallet: { usedUnitMs: number } };
  state.wallet.usedUnitMs = 500 * 1800000;
  f.stored.set('containerAccount', state);
  await reserveStorage(f.env, USER_ONE);
}

test('30-day funding is reserved; failed renewal warns once, sends reminders and renewal cancels deletion', async t => {
  const f = await fixture(t, 'charge'); f.app();
  await inventoryObject(f.env, f.owner, f.key('retained'), 1000000000, 'source');
  const funded = await reserveStorage(f.env, USER_ONE);
  assert.equal(funded!.fundedThrough, f.now() + 30 * STORAGE_DAY_MS);
  const state = f.stored.get('containerAccount') as { wallet: { storageHold: { remainingNanoUsd: number } } };
  assert.ok(state.wallet.storageHold.remainingNanoUsd >= 18000000);
  const emails: { subject: string; text: string }[] = [];
  f.env.WELCOME_EMAIL = { async send(message: any) { emails.push(message); return {}; } } as unknown as SendEmail;
  f.advance(STORAGE_DAY_MS);
  await unfund(f);
  await notifyStorageRetention(f.env);
  const row = () => f.sqlite.prepare('SELECT * FROM r2_accounts WHERE user_id=?').get(USER_ONE)!;
  assert.equal(row().delete_after, Math.ceil(f.now() / STORAGE_DAY_MS) * STORAGE_DAY_MS + 30 * STORAGE_DAY_MS);
  assert.ok(emails[0].text.includes(new Date(Number(row().delete_after)).toISOString()));
  assert.match(emails[0].text, /https:\/\/mainbrella.com\/balance\//);
  await notifyStorageRetention(f.env); assert.equal(emails.length, 1);
  f.setNow(Number(row().delete_after) - 7 * STORAGE_DAY_MS); await notifyStorageRetention(f.env);
  assert.equal(emails.length, 2); assert.equal(row().reminder_seven_at, f.now());
  f.advance(6 * STORAGE_DAY_MS); await notifyStorageRetention(f.env);
  assert.equal(emails.length, 3); assert.equal(row().reminder_one_at, f.now());
  const restored = f.stored.get('containerAccount') as { wallet: { usedUnitMs: number } };
  restored.wallet.usedUnitMs = 0; f.stored.set('containerAccount', restored);
  await reserveStorage(f.env, USER_ONE);
  assert.equal(row().writes_blocked, 0); assert.equal(row().delete_after, null); assert.equal(row().warned_at, null);
  f.advance(40 * STORAGE_DAY_MS); await expireUnfundedStorage(f.env);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM build_git_deletions').get()!.n, 0);
});

test('failed warning delivery and billing outages preserve files; recovered delivery gives 30 full days', async t => {
  const f = await fixture(t, 'charge'); f.app();
  await inventoryObject(f.env, f.owner, f.key('retained'), 1000, 'source');
  await unfund(f);
  f.env.WELCOME_EMAIL = { async send() { throw new Error('email_unavailable'); } } as unknown as SendEmail;
  await notifyStorageRetention(f.env);
  f.advance(45 * STORAGE_DAY_MS); await expireUnfundedStorage(f.env);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM build_git_deletions').get()!.n, 0);
  f.env.WELCOME_EMAIL = { async send() { return {}; } } as unknown as SendEmail;
  await notifyStorageRetention(f.env);
  const row = f.sqlite.prepare('SELECT * FROM r2_accounts WHERE user_id=?').get(USER_ONE)!;
  assert.equal(row.delete_after, Math.ceil(f.now() / STORAGE_DAY_MS) * STORAGE_DAY_MS + 30 * STORAGE_DAY_MS);
  f.advance(31 * STORAGE_DAY_MS);
  const get = f.env.CONTAINER_ACCOUNT.get;
  f.env.CONTAINER_ACCOUNT.get = (() => ({ async fetch() { throw new Error('billing_unavailable'); } })) as any;
  await expireUnfundedStorage(f.env);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM build_git_deletions').get()!.n, 0);
  f.env.CONTAINER_ACCOUNT.get = get;
  await expireUnfundedStorage(f.env);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM build_git_deletions').get()!.n, 1);
});

test('fresh funding before expiration cancels deletion, even if the D1 account still looks expired', async t => {
  const f = await fixture(t, 'charge'); f.app();
  await inventoryObject(f.env, f.owner, f.key('retained'), 1000, 'source');
  await unfund(f);
  f.sqlite.prepare('UPDATE r2_accounts SET delete_after=?,warned_at=? WHERE user_id=?').run(f.now() - 1, f.now() - 31 * STORAGE_DAY_MS, USER_ONE);
  const state = f.stored.get('containerAccount') as { wallet: { usedUnitMs: number } };
  state.wallet.usedUnitMs = 0; f.stored.set('containerAccount', state);
  await expireUnfundedStorage(f.env);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM build_git_deletions').get()!.n, 0);
  assert.equal(f.sqlite.prepare('SELECT writes_blocked FROM r2_accounts WHERE user_id=?').get(USER_ONE)!.writes_blocked, 0);
});

test('expired accounts complete once and sweeps advance beyond the first 20 accounts', async t => {
  const f = await fixture(t, 'charge');
  for (let i = 0; i < 25; i++) {
    const id = `expired-${String(i).padStart(2, '0')}`;
    f.sqlite.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(id, `${id}@example.com`, id, new Date(f.now()).toISOString());
    f.app(`app-${i}`, id);
    await inventoryObject(f.env, { userId: id, appId: `app-${i}` }, `build-git/${id}/app-${i}/objects/one`, 1, 'source');
    f.sqlite.prepare('UPDATE r2_accounts SET writes_blocked=1,delete_after=?,warned_at=? WHERE user_id=?').run(f.now() - 1, f.now() - 31 * STORAGE_DAY_MS, id);
  }
  f.env.CONTAINER_ACCOUNT.get = (() => ({ async fetch(request: Request) {
    const body = await request.json() as any;
    return Response.json({ fundedThrough: null, writesBlocked: true, deletionToken: body.action === 'expire' ? body.token : null });
  } })) as any;
  await expireUnfundedStorage(f.env); await expireUnfundedStorage(f.env); await expireUnfundedStorage(f.env);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM r2_accounts WHERE expired_at IS NOT NULL').get()!.n, 25);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM build_git_deletions').get()!.n, 25);
});

test('activation charges only full UTC days after enabling billing, never old metering history', async t => {
  const f = await fixture(t, 'charge');
  f.sqlite.exec("DELETE FROM r2_meter_state WHERE id='billing_activated_at'");
  await inventoryObject(f.env, f.owner, f.key('retained'), 1000000000, 'source');
  f.advance(3 * STORAGE_DAY_MS); await runStorageBilling(f.env);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM r2_receipts').get()!.n, 0);
  f.advance(2 * STORAGE_DAY_MS); await runStorageBilling(f.env);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM r2_receipts').get()!.n, 1);
});

test('platform quota and emergency pause bound physical growth without blocking deletion', async t => {
  const f = await fixture(t); f.env.R2_PLATFORM_MAX_BYTES = '10';
  await putStoredObject(f.env, f.owner, f.key('one'), new Uint8Array(6), 'source');
  await assert.rejects(putStoredObject(f.env, { userId: USER_TWO, appId: 'other' }, `build-git/${USER_TWO}/other/objects/two`, new Uint8Array(5), 'source'), /storage_platform_limit_exceeded/);
  f.env.R2_WRITES_PAUSED = 'true';
  await assert.rejects(putStoredObject(f.env, f.owner, f.key('new'), new Uint8Array(1), 'source'), /storage_growth_paused/);
  await putStoredObject(f.env, f.owner, f.key('one'), new Uint8Array(6), 'source');
  await deleteStoredObjects(f.env, f.owner, [f.key('one')]);
  assert.equal(f.storage.objects.size, 0);
});

test('export limits recover cancelled, completed and failed streams, and allow only six starts per minute', async t => {
  const f = await fixture(t);
  const stream = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); } }));
  const first = await storageReadAccess(f.env, USER_ONE, true, async () => stream());
  const second = await storageReadAccess(f.env, USER_ONE, true, async () => stream());
  await assert.rejects(storageReadAccess(f.env, USER_ONE, true, async () => stream()), /storage_export_busy/);
  await first.body!.cancel(); await second.body!.cancel();
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM r2_export_leases').get()!.n, 0);
  await assert.rejects(storageReadAccess(f.env, USER_ONE, true, async () => { throw new Error('export_failed'); }), /export_failed/);
  const complete = await storageReadAccess(f.env, USER_ONE, true, async () => new Response('done'));
  await complete.text();
  const sixth = await storageReadAccess(f.env, USER_ONE, true, async () => new Response('done')); await sixth.text();
  await assert.rejects(storageReadAccess(f.env, USER_ONE, true, async () => new Response('done')), /storage_rate_limited/);
  f.advance(60000);
  const resumed = await storageReadAccess(f.env, USER_ONE, true, async () => new Response('done')); await resumed.text();
});

test('storage health reports backlogs and sends bounded operator alerts', async t => {
  const f = await fixture(t); f.env.R2_PLATFORM_MAX_BYTES = '10';
  await inventoryObject(f.env, f.owner, f.key('retained'), 9, 'source');
  const emails: unknown[] = [];
  f.env.WELCOME_EMAIL = { async send(message: unknown) { emails.push(message); return {}; } } as unknown as SendEmail;
  await checkStorageHealth(f.env); await checkStorageHealth(f.env);
  assert.equal(emails.length, 1);
  f.advance(STORAGE_DAY_MS); await checkStorageHealth(f.env);
  assert.equal(emails.length, 2);
});

test('event streams have their own account slots and share the platform stream ceiling with exports', async t => {
  const f = await fixture(t);
  const stream = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); } }));
  const events = await storageReadAccess(f.env, USER_ONE, false, async () => stream(), true);
  const otherEvents = await storageReadAccess(f.env, USER_ONE, false, async () => stream(), true);
  await assert.rejects(storageReadAccess(f.env, USER_ONE, false, async () => stream(), true), /storage_stream_busy/);
  const exported = await storageReadAccess(f.env, USER_ONE, true, async () => stream());
  for (let i = 0; i < 97; i++) f.sqlite.prepare('INSERT INTO r2_export_leases VALUES(?,?,?)').run(`other-${i}`, `other-${i}`, f.now() + 60000);
  await assert.rejects(storageReadAccess(f.env, USER_TWO, true, async () => stream()), /storage_export_busy/);
  await events.body!.cancel(); await otherEvents.body!.cancel(); await exported.body!.cancel();
});

test('expired lease bounds abandoned exports and operation budgets fail before a provider read', async t => {
  const f = await fixture(t);
  f.sqlite.prepare('INSERT INTO r2_export_leases VALUES(?,?,?)').run('abandoned', USER_ONE, f.now() - 1);
  const response = await storageReadAccess(f.env, USER_ONE, true, async () => new Response('done')); await response.text();
  const window = Math.floor(f.now() / 60000);
  f.sqlite.prepare('INSERT INTO r2_rate_windows VALUES(?,?,?)').run('operations:global', window, 10000);
  await assert.rejects(getStoredObject(f.env, f.owner, f.key('missing')), /storage_rate_limited/);
  assert.equal(f.storage.reads.length, 0);
});

test('lost expiry acknowledgement reconciles the wallet claim without repeating deletion', async t => {
  const f = await fixture(t, 'charge'); f.app();
  await inventoryObject(f.env, f.owner, f.key('retained'), 1000, 'source');
  await unfund(f);
  f.sqlite.prepare('UPDATE r2_accounts SET delete_after=?,warned_at=? WHERE user_id=?').run(f.now() - 1, f.now() - 31 * STORAGE_DAY_MS, USER_ONE);
  const batch = f.env.DB.batch.bind(f.env.DB); let lost = false;
  f.env.DB.batch = (async statements => {
    const result = await batch(statements);
    if (!lost) { lost = true; throw new Error('lost_expiration_ack'); }
    return result;
  }) as D1Database['batch'];
  await expireUnfundedStorage(f.env);
  const row = () => f.sqlite.prepare('SELECT * FROM r2_accounts WHERE user_id=?').get(USER_ONE)!;
  assert.ok(row().expiration_token); assert.equal(row().expired_at, f.now());
  await expireUnfundedStorage(f.env);
  assert.equal(row().expiration_token, null);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM build_git_deletions').get()!.n, 1);
});

test('notice grace after paid retention records platform cost without creating customer debt', async t => {
  const f = await fixture(t, 'charge');
  await inventoryObject(f.env, f.owner, f.key('retained'), 1000000000, 'source');
  f.sqlite.prepare('UPDATE r2_accounts SET writes_blocked=1,funded_through=? WHERE user_id=?').run(f.now() - STORAGE_DAY_MS, USER_ONE);
  f.advance(STORAGE_DAY_MS);
  await finalizeStorageDay(f.env, '2026-10-01');
  assert.equal(f.sqlite.prepare('SELECT billable FROM r2_daily_usage').get()!.billable, 0);
  assert.equal(f.sqlite.prepare('SELECT provider_nano_usd FROM r2_daily_usage').get()!.provider_nano_usd, 500000);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM r2_receipts').get()!.n, 0);
});

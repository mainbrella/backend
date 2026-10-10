import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { reconcileAcquisitionBilling } from '../lib/acquisition-billing';

const USER = 'billing_user';
const LEAD = 'billing_lead';
const BASE = Date.UTC(2026, 9, 1);
const UNITS_PER_CENT = 1_800_000;

function fixture(t: test.TestContext) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  sqlite.exec('CREATE TABLE users(id TEXT PRIMARY KEY, created_at TEXT NOT NULL)');
  for (const migration of ['020_accounting_ledger', '021_acquisition']) {
    sqlite.exec(readFileSync(fileURLToPath(new URL(`../../migrations/${migration}.sql`, import.meta.url)), 'utf8'));
  }
  sqlite.prepare('INSERT INTO users(id,created_at) VALUES (?,?)').run(USER, new Date(BASE).toISOString());
  sqlite.prepare('INSERT INTO acquisition_leads(id,token_hash,repo,attribution_json,created_at) VALUES (?,?,?,?,?)')
    .run(LEAD, 'hash_billing', 'https://github.com/example/project', '{}', BASE);
  sqlite.prepare('INSERT INTO acquisition_accounts(user_id,lead_id,created_at) VALUES (?,?,?)').run(USER, LEAD, BASE);
  t.after(() => sqlite.close());

  interface Statement { sql: string; args: unknown[]; bind(...args: unknown[]): Statement;
    first<T>(): Promise<T | null>; all<T>(): Promise<{ results: T[] }>; run(): Promise<{ meta: { changes: number } }> }
  const prepare = (sql: string, args: unknown[] = []): Statement => ({
    sql, args,
    bind(...values: unknown[]) { return prepare(sql, values); },
    async first<T>() { return (sqlite.prepare(sql).get(...args as never[]) as T) ?? null; },
    async all<T>() { return { results: sqlite.prepare(sql).all(...args as never[]) as T[] }; },
    async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...args as never[]).changes) } }; },
  });
  const env = { ACQUISITION_ENABLED: 'true', DB: {
    prepare,
    async batch(statements: Statement[]) {
      sqlite.exec('BEGIN');
      try {
        const results = statements.map(statement => ({ meta: { changes: Number(sqlite.prepare(statement.sql).run(...statement.args as never[]).changes) } }));
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  } } as unknown as Parameters<typeof reconcileAcquisitionBilling>[0];
  const ledger = (type: string, key: string, at: number, data: Record<string, unknown>) => {
    sqlite.prepare('INSERT INTO accounting_ledger(event_key,user_id,event_type,occurred_at,recorded_at,payload) VALUES (?,?,?,?,?,?)')
      .run(key, USER, type, at, at, JSON.stringify(data));
  };
  const funding = (id: string, at: number, creditCents: number, considerationCents: number, taxCents = 0) => ledger('funding', `funding:${id}`, at,
    { fundingId: id, creditCents, amountPaidCents: considerationCents + taxCents, taxCollectedCents: taxCents,
      considerationCents, promotionalCreditCents: creditCents - considerationCents });
  const state = (id: string, at: number, creditCents: number, revokedCents = 0) => ledger('funding_state', `funding_state:${id}:${revokedCents}`, at,
    { fundingId: id, creditCents, revokedCents });
  const compute = (id: string, at: number, cents: number) => ledger('compute', `compute:${id}`, at + cents * UNITS_PER_CENT,
    { resourceId: id, startAt: at, endAt: at + cents * UNITS_PER_CENT, unitMs: cents * UNITS_PER_CENT, unitMsPerCent: UNITS_PER_CENT });
  const events = (type: string) => sqlite.prepare('SELECT event_key,lead_id,payload FROM acquisition_events WHERE event_type = ? ORDER BY sequence')
    .all(type).map(row => ({ key: row.event_key as string, leadId: row.lead_id as string | null, data: JSON.parse(row.payload as string) }));
  return { sqlite, env, ledger, funding, state, compute, events };
}

test('projects paid consideration after wallet delivery and excludes fully promotional funding and usage', async t => {
  const f = fixture(t);
  f.funding('cs_free', BASE, 1000, 0);
  f.state('cs_free', BASE + 1, 1000);
  f.compute('free_runtime', BASE + 2, 1000);
  const paidAt = BASE + 1000 * UNITS_PER_CENT + 10;
  f.funding('pi_paid', paidAt, 2000, 1000, 100);
  f.state('pi_paid', paidAt + 1, 2000);
  f.compute('paid_runtime', paidAt + 2, 1000);

  const result = await reconcileAcquisitionBilling(f.env);
  assert.deepEqual(result.errors, []);
  assert.equal(result.usersProcessed, 1);
  const funding = f.events('wallet.funded_paid');
  assert.equal(funding.length, 1);
  assert.equal(funding[0].leadId, LEAD);
  assert.equal(funding[0].data.considerationCents, 1000);
  assert.equal(funding[0].data.taxCollectedCents, 100);
  const usage = f.events('compute.consumed_paid');
  assert.equal(usage.length, 1);
  assert.equal(usage[0].data.sourceEventKey, 'compute:paid_runtime');
  assert.equal(usage[0].data.paidMicroUsdDelta, '5000000');
  assert.equal(usage[0].leadId, LEAD);
  await reconcileAcquisitionBilling(f.env);
  assert.equal(f.events('compute.consumed_paid').length, 1);
});

test('receipt alone does not claim wallet funding and later delivery resumes reconciliation', async t => {
  const f = fixture(t);
  f.funding('pi_pending', BASE, 1000, 1000);
  const pending = await reconcileAcquisitionBilling(f.env);
  assert.deepEqual(pending.errors, []);
  assert.equal(f.events('wallet.funded_paid').length, 0);
  f.state('pi_pending', BASE + 1, 1000);
  const complete = await reconcileAcquisitionBilling(f.env);
  assert.deepEqual(complete.errors, []);
  assert.equal(f.events('wallet.funded_paid').length, 1);
});

test('late revocation appends a signed correction without erasing the original paid usage', async t => {
  const f = fixture(t);
  f.funding('pi_paid', BASE, 2000, 1000);
  f.state('pi_paid', BASE + 1, 2000);
  f.compute('runtime', BASE + 100, 1000);
  await reconcileAcquisitionBilling(f.env);
  f.state('pi_paid', BASE + 50, 2000, 2000);
  const result = await reconcileAcquisitionBilling(f.env);
  assert.deepEqual(result.errors, []);
  const deltas = f.events('compute.consumed_paid').map(row => row.data.paidMicroUsdDelta);
  assert.deepEqual(deltas, ['5000000', '-5000000']);
  assert.equal(f.events('wallet.funded_paid').length, 1);
  await reconcileAcquisitionBilling(f.env);
  assert.equal(f.events('compute.consumed_paid').length, 2);
});

test('a later partial refund limits future rights without rewriting delivered usage', async t => {
  const f = fixture(t);
  f.funding('pi_paid', BASE, 2000, 1000);
  f.state('pi_paid', BASE + 1, 2000);
  f.compute('before_refund', BASE + 100, 1000);
  await reconcileAcquisitionBilling(f.env);
  const refundAt = BASE + 100 + 1000 * UNITS_PER_CENT + 1;
  f.ledger('refund', 'refund:re_partial', refundAt, { fundingId: 'pi_paid', refundId: 're_partial', amountCents: 250, taxRefundedCents: 0 });
  f.state('pi_paid', refundAt + 1, 2000, 500);
  f.compute('after_refund', refundAt + 2, 500);
  const result = await reconcileAcquisitionBilling(f.env);
  assert.deepEqual(result.errors, []);
  const usage = f.events('compute.consumed_paid');
  assert.deepEqual(usage.map(row => row.data.paidMicroUsdDelta), ['5000000', '2500000']);
});

test('checkpoint-only revocation constrains later paid compute allocation', async t => {
  const f = fixture(t);
  f.funding('pi_paid', BASE, 2000, 1000);
  f.ledger('wallet_checkpoint', 'checkpoint:initial', BASE + 1,
    { asOf: BASE + 1, usedUnitMs: 0, fundings: [{ id: 'pi_paid', creditCents: 2000, revokedCents: 0 }] });
  f.ledger('wallet_checkpoint', 'checkpoint:revoked', BASE + 50,
    { asOf: BASE + 50, usedUnitMs: 0, fundings: [{ id: 'pi_paid', creditCents: 2000, revokedCents: 1000 }] });
  f.compute('after_checkpoint', BASE + 100, 2000);
  const result = await reconcileAcquisitionBilling(f.env);
  assert.deepEqual(result.errors, []);
  assert.equal(f.events('wallet.funded_paid').length, 1);
  assert.deepEqual(f.events('compute.consumed_paid').map(row => row.data.paidMicroUsdDelta), ['5000000']);
});

test('an undelivered receipt does not freeze paid usage from a delivered lot', async t => {
  const f = fixture(t);
  f.funding('pi_undelivered', BASE, 1000, 1000);
  f.funding('pi_delivered', BASE + 1, 1000, 1000);
  f.state('pi_delivered', BASE + 2, 1000);
  f.compute('delivered_runtime', BASE + 3, 500);
  const result = await reconcileAcquisitionBilling(f.env);
  assert.deepEqual(result.errors, []);
  assert.equal(f.events('wallet.funded_paid').length, 1);
  assert.equal(f.events('wallet.funded_paid')[0].data.fundingId, 'pi_delivered');
  assert.deepEqual(f.events('compute.consumed_paid').map(row => row.data.paidMicroUsdDelta), ['5000000']);
});

test('legacy usage consumes FIFO lots without becoming a paid product event', async t => {
  const f = fixture(t);
  f.funding('pi_paid', BASE, 1000, 1000);
  f.state('pi_paid', BASE + 1, 1000);
  f.ledger('legacy_usage', 'legacy_usage:billing_user', BASE + 2, { unitMs: 1000 * UNITS_PER_CENT, monthlyUnitMs: {} });
  f.funding('cs_free', BASE + 3, 1000, 0);
  f.state('cs_free', BASE + 4, 1000);
  f.compute('promo_runtime', BASE + 5, 1000);
  const result = await reconcileAcquisitionBilling(f.env);
  assert.deepEqual(result.errors, []);
  assert.equal(f.events('wallet.funded_paid').length, 1);
  assert.equal(f.events('compute.consumed_paid').length, 0);
});

test('history limits report an unsupported account without advancing its cursor', async t => {
  const f = fixture(t);
  f.funding('pi_paid', BASE, 1000, 1000);
  f.state('pi_paid', BASE + 1, 1000);
  const result = await reconcileAcquisitionBilling(f.env, { maxLedgerRowsPerUser: 1 });
  assert.deepEqual(result.errors, [{ userId: USER, reason: 'acquisition_billing_history_limit' }]);
  assert.equal(f.sqlite.prepare('SELECT through_sequence FROM acquisition_projection_accounts WHERE user_id=?').get(USER), undefined);
});

test('bounded replay advances in batches and concurrent runs cannot duplicate paid usage', async t => {
  const f = fixture(t);
  f.funding('pi_paid', BASE, 1000, 1000);
  f.state('pi_paid', BASE + 1, 1000);
  f.compute('runtime', BASE + 2, 500);
  const first = await reconcileAcquisitionBilling(f.env, { maxNewRowsPerUser: 2 });
  assert.equal(first.hasMore, true);
  assert.equal(f.events('compute.consumed_paid').length, 0);
  const overlapping = await Promise.all([
    reconcileAcquisitionBilling(f.env, { maxNewRowsPerUser: 2 }),
    reconcileAcquisitionBilling(f.env, { maxNewRowsPerUser: 2 }),
  ]);
  assert.ok(overlapping.some(result => result.usersProcessed === 1));
  assert.equal(f.events('compute.consumed_paid').length, 1);
  assert.equal(f.events('compute.consumed_paid')[0].data.paidMicroUsdDelta, '5000000');
});

test('disabled projection reads no ledger or acquisition tables', async () => {
  const env = { ACQUISITION_ENABLED: 'false', DB: { prepare() { throw new Error('unexpected_db_read'); } } } as unknown as Parameters<typeof reconcileAcquisitionBilling>[0];
  assert.deepEqual(await reconcileAcquisitionBilling(env),
    { throughSequence: 0, usersProcessed: 0, hasMore: false, nextUserId: null, errors: [] });
});

test('durable lexical scan reaches later accounts despite an earlier blocked account', async t => {
  const f = fixture(t);
  const add = (userId: string, key: string, type: string, at: number, data: Record<string, unknown>) => {
    f.sqlite.prepare('INSERT INTO accounting_ledger(event_key,user_id,event_type,occurred_at,recorded_at,payload) VALUES (?,?,?,?,?,?)')
      .run(key, userId, type, at, at, JSON.stringify(data));
  };
  for (const userId of ['a', 'b', 'c']) f.sqlite.prepare('INSERT INTO users(id,created_at) VALUES (?,?)').run(userId, new Date(BASE).toISOString());
  for (const userId of ['a', 'b', 'c']) {
    add(userId, `funding:pi_${userId}`, 'funding', BASE, { fundingId: `pi_${userId}`, creditCents: 1000,
      amountPaidCents: 1000, taxCollectedCents: 0, considerationCents: 1000, promotionalCreditCents: 0 });
    add(userId, `funding_state:pi_${userId}`, 'funding_state', BASE + 1,
      { fundingId: `pi_${userId}`, creditCents: userId === 'a' ? 2000 : 1000, revokedCents: 0 });
  }
  const first = await reconcileAcquisitionBilling(f.env, { maxUsers: 1 });
  assert.deepEqual(first.errors, [{ userId: 'a', reason: 'wallet_funding_evidence_mismatch' }]);
  const second = await reconcileAcquisitionBilling(f.env, { maxUsers: 1 });
  const third = await reconcileAcquisitionBilling(f.env, { maxUsers: 1 });
  assert.equal(second.usersProcessed, 1);
  assert.equal(third.usersProcessed, 1);
  assert.deepEqual(f.events('wallet.funded_paid').map(row => row.data.fundingId), ['pi_b', 'pi_c']);
  assert.equal((f.sqlite.prepare('SELECT after_user_id FROM acquisition_projection_scan WHERE id=1').get() as { after_user_id: string }).after_user_id, '');
});

import { appendProductEvent, appendProductEventsWithCursor } from './acquisition';
import type { LedgerRow } from './accounting-ledger';
import type { BillingEnv } from './stripe';

type Env = Parameters<typeof appendProductEvent>[0] & Pick<BillingEnv, 'DB'> & { ACQUISITION_ENABLED?: string };

const UNIT_MS_PER_CENT = 1_800_000n;
const MICRO_USD_PER_CENT = 10_000n;
const DEFAULT_MAX_USERS = 25;
const DEFAULT_MAX_LEDGER_ROWS_PER_USER = 10_000;
const DEFAULT_MAX_NEW_ROWS_PER_USER = 100;
const DEFAULT_MAX_EVENTS_PER_BATCH = 200;
const PAGE_SIZE = 500;

interface FundingData {
  fundingId: string;
  creditCents: number;
  amountPaidCents: number;
  taxCollectedCents: number;
  considerationCents: number;
  promotionalCreditCents: number;
}
interface FundingStateData { fundingId: string; creditCents: number; revokedCents: number }
interface WalletCheckpointData { fundings: Array<{ id: string; creditCents: number; revokedCents: number }> }
interface ComputeData { startAt: number; endAt: number; unitMs: number; unitMsPerCent: number }
interface FundingLot { id: string; units: bigint; revoked: bigint; consumed: bigint; consideration: bigint }
interface PriorProductRow { payload: string }
interface Segment { row: LedgerRow; at: number; data: FundingData | FundingStateData | WalletCheckpointData | ComputeData | { unitMs: number } }
type ProductEvent = Parameters<typeof appendProductEvent>[1];

export interface AcquisitionBillingOptions {
  throughSequence?: number;
  afterUserId?: string;
  maxUsers?: number;
  maxLedgerRowsPerUser?: number;
  maxNewRowsPerUser?: number;
  maxEventsPerBatch?: number;
}
export interface AcquisitionBillingResult {
  throughSequence: number;
  usersProcessed: number;
  hasMore: boolean;
  nextUserId: string | null;
  errors: { userId: string; reason: string }[];
}

function integer(value: unknown, name: string, allowZero = true): number {
  if (!Number.isSafeInteger(value) || (value as number) < (allowZero ? 0 : 1)) throw new Error(`invalid_${name}`);
  return value as number;
}

async function ledgerRowsForUser(env: Env, userId: string, throughSequence: number, maxRows: number): Promise<LedgerRow[]> {
  const rows: LedgerRow[] = [];
  let after = 0;
  while (true) {
    const limit = Math.min(PAGE_SIZE, maxRows - rows.length + 1);
    const page = await env.DB.prepare('SELECT * FROM accounting_ledger WHERE user_id = ? AND sequence > ? AND sequence <= ? ORDER BY sequence LIMIT ?')
      .bind(userId, after, throughSequence, limit).all<LedgerRow>();
    rows.push(...page.results);
    if (rows.length > maxRows) throw new Error('acquisition_billing_history_limit');
    if (page.results.length < limit) return rows;
    after = page.results.at(-1)!.sequence;
  }
}

async function priorProductRows(env: Env, userId: string, maxRows: number): Promise<PriorProductRow[]> {
  const rows: PriorProductRow[] = [];
  let after = 0;
  while (true) {
    const limit = Math.min(PAGE_SIZE, maxRows - rows.length + 1);
    const page = await env.DB.prepare("SELECT sequence,payload FROM acquisition_events WHERE user_id = ? AND event_type = 'compute.consumed_paid' AND sequence > ? ORDER BY sequence LIMIT ?")
      .bind(userId, after, limit).all<PriorProductRow & { sequence: number }>();
    rows.push(...page.results);
    if (rows.length > maxRows) throw new Error('acquisition_billing_projection_limit');
    if (page.results.length < limit) return rows;
    after = page.results.at(-1)!.sequence;
  }
}

function splitCompute(row: LedgerRow, data: ComputeData, cuts: number[]): Segment[] {
  const start = integer(data.startAt, 'compute_start', false);
  const end = integer(data.endAt, 'compute_end', false);
  const total = integer(data.unitMs, 'compute_units');
  if (end <= start || data.unitMsPerCent !== Number(UNIT_MS_PER_CENT)) throw new Error('invalid_compute_interval');
  const points = [start, ...cuts.filter(at => at > start && at < end), end].sort((a, b) => a - b);
  const result: Segment[] = [];
  for (let index = 1; index < points.length; index++) {
    const before = BigInt(total) * BigInt(points[index - 1] - start) / BigInt(end - start);
    const after = BigInt(total) * BigInt(points[index] - start) / BigInt(end - start);
    result.push({ row, at: points[index], data: { ...data, startAt: points[index - 1], endAt: points[index], unitMs: Number(after - before) } });
  }
  return result;
}

function paidComputeBySource(rows: LedgerRow[], delivered: Set<string>): Map<string, bigint> {
  const relevant = rows.filter(row => {
    if (row.event_type === 'funding' || row.event_type === 'funding_state') {
      const data = JSON.parse(row.payload) as { fundingId: string };
      return delivered.has(data.fundingId);
    }
    return ['compute', 'legacy_usage', 'wallet_checkpoint'].includes(row.event_type);
  });
  const cuts = relevant.filter(row => ['funding', 'funding_state', 'wallet_checkpoint'].includes(row.event_type)).map(row => row.occurred_at);
  const segments: Segment[] = relevant.flatMap(row => {
    const data = JSON.parse(row.payload);
    return row.event_type === 'compute' ? splitCompute(row, data as ComputeData, cuts) : [{ row, at: row.occurred_at, data }];
  });
  segments.sort((a, b) => a.at - b.at || Number(a.row.event_type !== 'compute') - Number(b.row.event_type !== 'compute') || a.row.sequence - b.row.sequence);

  const lots: FundingLot[] = [];
  const byId = new Map<string, FundingLot>();
  const paidBySource = new Map<string, bigint>();
  for (const { row, data } of segments) {
    if (row.event_type === 'funding') {
      const funding = data as FundingData;
      const credit = integer(funding.creditCents, 'funding_credit', false);
      const consideration = integer(funding.considerationCents, 'funding_consideration');
      if (consideration > credit || integer(funding.amountPaidCents, 'funding_paid') < consideration
        || integer(funding.taxCollectedCents, 'funding_tax') + consideration !== funding.amountPaidCents
        || integer(funding.promotionalCreditCents, 'funding_promotion') + consideration !== credit
        || !funding.fundingId || byId.has(funding.fundingId)) throw new Error('invalid_funding');
      const lot = { id: funding.fundingId, units: BigInt(credit) * UNIT_MS_PER_CENT, revoked: 0n, consumed: 0n,
        consideration: BigInt(consideration) * MICRO_USD_PER_CENT };
      lots.push(lot); byId.set(lot.id, lot);
    } else if (row.event_type === 'funding_state' || row.event_type === 'wallet_checkpoint') {
      const states: FundingStateData[] = row.event_type === 'funding_state' ? [data as FundingStateData]
        : (data as WalletCheckpointData).fundings.map(funding => ({ fundingId: funding.id, creditCents: funding.creditCents, revokedCents: funding.revokedCents }));
      for (const state of states) {
        if (!delivered.has(state.fundingId)) continue;
        const lot = byId.get(state.fundingId);
        if (!lot) throw new Error('funding_state_without_receipt');
        if (BigInt(integer(state.creditCents, 'funding_state_credit')) * UNIT_MS_PER_CENT !== lot.units
          || BigInt(integer(state.revokedCents, 'funding_state_revoked')) * UNIT_MS_PER_CENT > lot.units) throw new Error('invalid_funding_state');
        const revoked = BigInt(state.revokedCents) * UNIT_MS_PER_CENT;
        if (revoked > lot.revoked) lot.revoked = revoked;
      }
    } else {
      let remaining = BigInt(integer((data as { unitMs: number }).unitMs, 'usage_units'));
      for (const lot of lots) {
        const available = lot.units - lot.revoked - lot.consumed;
        if (available <= 0n) continue;
        const take = remaining < available ? remaining : available;
        const before = lot.consideration * lot.consumed / lot.units;
        lot.consumed += take;
        const paid = lot.consideration * lot.consumed / lot.units - before;
        if (row.event_type === 'compute') paidBySource.set(row.event_key, (paidBySource.get(row.event_key) ?? 0n) + paid);
        remaining -= take;
        if (remaining === 0n) break;
      }
      // Revocations can make the wallet negative after delivered compute. The
      // unallocated remainder has no paid consideration; earlier delivery stays.
    }
  }
  return paidBySource;
}

async function reconcileUser(env: Env, userId: string, throughSequence: number, maxRows: number,
  maxNewRows: number, maxEvents: number): Promise<{ committed: boolean; pending: boolean }> {
  const cursor = await env.DB.prepare('SELECT through_sequence FROM acquisition_projection_accounts WHERE user_id = ?')
    .bind(userId).first<{ through_sequence: number }>();
  const expectedThrough = cursor?.through_sequence ?? 0;
  if (expectedThrough >= throughSequence) return { committed: true, pending: false };
  const allRows = await ledgerRowsForUser(env, userId, throughSequence, maxRows);
  const newRows = allRows.filter(row => row.sequence > expectedThrough);
  if (!newRows.length) return { committed: false, pending: false };
  const targetSequence = newRows[Math.min(newRows.length, maxNewRows) - 1].sequence;
  const rows = allRows.filter(row => row.sequence <= targetSequence);
  const pending = newRows.length > maxNewRows;
  const walletEvidence = new Map<string, number>(), fundedPositive = new Set<string>(), newlyPositive = new Set<string>();
  for (const row of rows) {
    if (row.event_type === 'funding_state') {
      const data = JSON.parse(row.payload) as FundingStateData;
      walletEvidence.set(data.fundingId, data.creditCents);
      if (data.revokedCents < data.creditCents) {
        fundedPositive.add(data.fundingId);
        if (row.sequence > expectedThrough) newlyPositive.add(data.fundingId);
      }
    } else if (row.event_type === 'wallet_checkpoint') {
      const data = JSON.parse(row.payload) as WalletCheckpointData;
      for (const funding of data.fundings ?? []) {
        walletEvidence.set(funding.id, funding.creditCents);
        if (funding.revokedCents < funding.creditCents) {
          fundedPositive.add(funding.id);
          if (row.sequence > expectedThrough) newlyPositive.add(funding.id);
        }
      }
    }
  }
  const events: ProductEvent[] = [];
  for (const row of rows) {
    if (row.event_type !== 'funding') continue;
    const data = JSON.parse(row.payload) as FundingData;
    if (!walletEvidence.has(data.fundingId)) continue;
    if (walletEvidence.get(data.fundingId) !== data.creditCents) throw new Error('wallet_funding_evidence_mismatch');
    if (data.considerationCents <= 0 || !fundedPositive.has(data.fundingId)) continue;
    if (row.sequence <= expectedThrough && !newlyPositive.has(data.fundingId)) continue;
    events.push({ key: `wallet.funded_paid:${data.fundingId}`, type: 'wallet.funded_paid', userId,
      occurredAt: row.occurred_at, data: { sourceEventKey: row.event_key, sourceLedgerSequence: row.sequence,
        fundingId: data.fundingId, considerationCents: data.considerationCents, creditCents: data.creditCents,
        promotionalCreditCents: data.promotionalCreditCents, amountPaidCents: data.amountPaidCents,
        taxCollectedCents: data.taxCollectedCents, currency: 'usd' } });
  }

  const priorRows = await priorProductRows(env, userId, maxRows * 2);
  const prior = new Map<string, bigint>();
  for (const product of priorRows) {
    const data = JSON.parse(product.payload) as { sourceEventKey: string; paidMicroUsdDelta: string };
    if (typeof data.sourceEventKey !== 'string' || !/^-?\d+$/.test(data.paidMicroUsdDelta)) throw new Error('invalid_prior_projection');
    prior.set(data.sourceEventKey, (prior.get(data.sourceEventKey) ?? 0n) + BigInt(data.paidMicroUsdDelta));
  }
  // Receipts can precede wallet delivery. Unconfirmed lots cannot pay for
  // compute; a later wallet state replays and corrects any provisional FIFO use.
  const desired = paidComputeBySource(rows, fundedPositive);
  const compute = new Map(rows.filter(row => row.event_type === 'compute').map(row => [row.event_key, row]));
  for (const [sourceEventKey, row] of compute) {
    const target = desired.get(sourceEventKey) ?? 0n;
    const delta = target - (prior.get(sourceEventKey) ?? 0n);
    if (delta === 0n) continue;
    events.push({ key: `compute.consumed_paid:${row.sequence}:${targetSequence}`,
      type: 'compute.consumed_paid', userId, occurredAt: row.occurred_at,
      data: { sourceEventKey, sourceLedgerSequence: row.sequence, paidMicroUsdDelta: delta.toString(),
        paidMicroUsdTotal: target.toString(), projectionRevision: targetSequence, currency: 'usd' } });
  }
  if (events.length > maxEvents) throw new Error('acquisition_billing_event_limit');
  const committed = await appendProductEventsWithCursor(env, userId, expectedThrough, targetSequence, events);
  return { committed, pending };
}

/** Bounded D1-only reconciliation; retries append the same keys after partial failure. */
export async function reconcileAcquisitionBilling(env: Env, options: AcquisitionBillingOptions = {}): Promise<AcquisitionBillingResult> {
  if (env.ACQUISITION_ENABLED !== 'true') return { throughSequence: options.throughSequence ?? 0,
    usersProcessed: 0, hasMore: false, nextUserId: null, errors: [] };
  const throughSequence = options.throughSequence ?? (await env.DB.prepare('SELECT COALESCE(MAX(sequence),0) AS sequence FROM accounting_ledger').first<{ sequence: number }>())!.sequence;
  const maxUsers = options.maxUsers ?? DEFAULT_MAX_USERS;
  const maxRows = options.maxLedgerRowsPerUser ?? DEFAULT_MAX_LEDGER_ROWS_PER_USER;
  const maxNewRows = options.maxNewRowsPerUser ?? Math.min(DEFAULT_MAX_NEW_ROWS_PER_USER, maxRows);
  const maxEvents = options.maxEventsPerBatch ?? DEFAULT_MAX_EVENTS_PER_BATCH;
  if (!Number.isSafeInteger(throughSequence) || throughSequence < 0 || !Number.isSafeInteger(maxUsers) || maxUsers < 1 || maxUsers > 100
    || !Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 100_000
    || !Number.isSafeInteger(maxNewRows) || maxNewRows < 1 || maxNewRows > maxRows
    || !Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 1000) throw new Error('invalid_acquisition_billing_options');
  const savedScan = options.afterUserId === undefined
    ? await env.DB.prepare('SELECT after_user_id FROM acquisition_projection_scan WHERE id = 1').first<{ after_user_id: string }>() : null;
  if (options.afterUserId === undefined && !savedScan) throw new Error('acquisition_projection_scan_missing');
  const scanAfter = options.afterUserId ?? savedScan!.after_user_id;
  const findCandidates = (after: string) => env.DB.prepare(`SELECT DISTINCT ledger.user_id FROM accounting_ledger AS ledger
    LEFT JOIN acquisition_projection_accounts AS projection ON projection.user_id = ledger.user_id
    WHERE ledger.sequence > COALESCE(projection.through_sequence,0) AND ledger.sequence <= ? AND ledger.user_id > ?
    ORDER BY ledger.user_id LIMIT ?`).bind(throughSequence, after, maxUsers + 1).all<{ user_id: string }>();
  let candidates = await findCandidates(scanAfter);
  if (!candidates.results.length && scanAfter && options.afterUserId === undefined) candidates = await findCandidates('');
  const users = candidates.results.slice(0, maxUsers), errors: AcquisitionBillingResult['errors'] = [];
  let processed = 0, pending = false;
  for (const { user_id: userId } of users) {
    try {
      const result = await reconcileUser(env, userId, throughSequence, maxRows, maxNewRows, maxEvents);
      if (result.committed) { processed++; pending ||= result.pending; }
      else errors.push({ userId, reason: 'projection_cursor_changed' });
    }
    catch (error) { errors.push({ userId, reason: error instanceof Error ? error.message : 'acquisition_billing_failed' }); }
  }
  if (savedScan) {
    // Advance past attempted users even when one account needs manual repair.
    // Wrap at the lexical end so old accounts receive another chance next run.
    const next = candidates.results.length > maxUsers ? users.at(-1)!.user_id : '';
    await env.DB.prepare('UPDATE acquisition_projection_scan SET after_user_id = ? WHERE id = 1 AND after_user_id = ?')
      .bind(next, savedScan.after_user_id).run();
  }
  return { throughSequence, usersProcessed: processed, hasMore: pending || candidates.results.length > maxUsers,
    nextUserId: candidates.results.length > maxUsers ? users.at(-1)!.user_id : null, errors };
}

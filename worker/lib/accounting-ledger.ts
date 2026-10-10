import type { BillingEnv } from './stripe';

export interface TaxLocation { country: string | null; state: string | null; postalCode: string | null; city: string | null; source: 'checkout' | 'charge' | 'unknown' }
export interface AccountingEvent {
  key: string; userId: string; type: 'funding' | 'refund' | 'stripe_balance' | 'funding_state' | 'compute' | 'inference' | 'storage' | 'storage_adjustment' | 'legacy_usage' | 'wallet_checkpoint';
  occurredAt: number; data: Record<string, unknown>;
}
export interface LedgerRow { sequence: number; event_key: string; user_id: string; event_type: AccountingEvent['type']; occurred_at: number; recorded_at: number; payload: string }

// Canonical payloads make duplicate identities verifiable, including nested data.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
export async function appendAccountingEvent(env: Pick<BillingEnv, 'DB'>, event: AccountingEvent): Promise<void> {
  if (!event.key || !event.userId || !Number.isSafeInteger(event.occurredAt) || event.occurredAt <= 0) throw new Error('invalid_accounting_event');
  const payload = canonical(event.data);
  await env.DB.prepare(`INSERT INTO accounting_ledger (event_key,user_id,event_type,occurred_at,recorded_at,payload)
    VALUES (?,?,?,?,?,?) ON CONFLICT(event_key) DO NOTHING`).bind(event.key, event.userId, event.type, event.occurredAt, Date.now(), payload).run();
  const saved = await env.DB.prepare('SELECT user_id,event_type,occurred_at,payload FROM accounting_ledger WHERE event_key = ?').bind(event.key).first<LedgerRow>();
  if (!saved || saved.user_id !== event.userId || saved.event_type !== event.type || saved.occurred_at !== event.occurredAt || saved.payload !== payload) throw new Error('accounting_event_conflict');
}
export async function ledgerRows(env: Pick<BillingEnv, 'DB'>, throughSequence: number): Promise<LedgerRow[]> {
  const rows: LedgerRow[] = [];
  let after = 0;
  while (true) {
    const page = await env.DB.prepare('SELECT * FROM accounting_ledger WHERE sequence > ? AND sequence <= ? ORDER BY sequence LIMIT 1000').bind(after, throughSequence).all<LedgerRow>();
    rows.push(...page.results);
    if (page.results.length < 1000) return rows;
    after = page.results.at(-1)!.sequence;
  }
}
export async function ledgerWatermark(env: Pick<BillingEnv, 'DB'>): Promise<number> {
  return (await env.DB.prepare('SELECT COALESCE(MAX(sequence),0) AS sequence FROM accounting_ledger').first<{ sequence: number }>())!.sequence;
}

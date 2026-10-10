export const acquisitionEventTypes = [
  'repo.submitted', 'lead.captured', 'user.created', 'workspace.started', 'workload.activated',
  'preview.opened', 'developer.qualified', 'wallet.funded_paid', 'compute.consumed_paid', 'launch.failed',
] as const;
export type AcquisitionEventType = typeof acquisitionEventTypes[number];
export interface ProductEvent {
  key: string;
  type: AcquisitionEventType;
  userId?: string | null;
  leadId?: string | null;
  occurredAt: number;
  data: Record<string, unknown>;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export async function appendProductEvent(env: { DB: D1Database }, event: ProductEvent): Promise<void> {
  if (!/^[A-Za-z0-9:._/-]{1,240}$/.test(event.key) || !acquisitionEventTypes.includes(event.type) ||
      !Number.isSafeInteger(event.occurredAt) || event.occurredAt <= 0 ||
      (event.userId != null && (typeof event.userId !== 'string' || event.userId.length > 200)) ||
      (event.leadId != null && (typeof event.leadId !== 'string' || event.leadId.length > 200)) ||
      !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) {
    throw new Error('invalid_product_event');
  }
  let leadId = event.leadId ?? null;
  if (!leadId && event.userId) {
    const account = await env.DB.prepare('SELECT lead_id FROM acquisition_accounts WHERE user_id = ?')
      .bind(event.userId).first<{ lead_id: string }>();
    leadId = account?.lead_id ?? null;
  }
  const payload = stableJson(event.data);
  const inserted = await env.DB.prepare(
    `INSERT INTO acquisition_events(event_key,event_type,user_id,lead_id,occurred_at,recorded_at,payload)
     VALUES(?,?,?,?,?,?,?) ON CONFLICT(event_key) DO NOTHING`,
  ).bind(event.key, event.type, event.userId ?? null, leadId, event.occurredAt, Date.now(), payload).run();
  if (inserted.meta.changes) return;
  const prior = await env.DB.prepare('SELECT event_type,user_id,lead_id,occurred_at,payload FROM acquisition_events WHERE event_key = ?')
    .bind(event.key).first<{ event_type: string; user_id: string | null; lead_id: string | null; occurred_at: number; payload: string }>();
  if (!prior || prior.event_type !== event.type || prior.user_id !== (event.userId ?? null) ||
      (event.leadId != null ? prior.lead_id !== event.leadId : Boolean(prior.lead_id && prior.lead_id !== leadId)) ||
      prior.occurred_at !== event.occurredAt || prior.payload !== payload) {
    throw new Error('product_event_key_conflict');
  }
}

export async function appendProductEventsWithCursor(
  env: { DB: D1Database }, userId: string, expectedThrough: number, nextThrough: number, events: ProductEvent[],
): Promise<boolean> {
  if (typeof userId !== 'string' || !userId || userId.length > 200 || !Number.isSafeInteger(expectedThrough) || expectedThrough < 0 ||
      !Number.isSafeInteger(nextThrough) || nextThrough < expectedThrough ||
      events.some(event => event.userId !== userId || !Number.isSafeInteger(event.occurredAt) || event.occurredAt <= 0 ||
        !/^[A-Za-z0-9:._/-]{1,240}$/.test(event.key) || !acquisitionEventTypes.includes(event.type) ||
        (event.leadId != null && (typeof event.leadId !== 'string' || event.leadId.length > 200)) ||
        !event.data || typeof event.data !== 'object' || Array.isArray(event.data))) {
    throw new Error('invalid_product_event_batch');
  }
  const account = await env.DB.prepare('SELECT lead_id FROM acquisition_accounts WHERE user_id=?').bind(userId).first<{ lead_id: string }>();
  const leadId = account?.lead_id ?? null;
  const statements: D1PreparedStatement[] = [
    env.DB.prepare('INSERT INTO acquisition_projection_accounts(user_id,through_sequence) VALUES(?,0) ON CONFLICT(user_id) DO NOTHING').bind(userId),
    ...events.map(event => env.DB.prepare(`INSERT INTO acquisition_events(event_key,event_type,user_id,lead_id,occurred_at,recorded_at,payload)
      SELECT ?,?,?,?,?,?,? WHERE (SELECT through_sequence FROM acquisition_projection_accounts WHERE user_id=?)=?
      ON CONFLICT(event_key) DO UPDATE SET payload=excluded.payload
      WHERE acquisition_events.event_type IS NOT excluded.event_type
        OR acquisition_events.user_id IS NOT excluded.user_id
        OR acquisition_events.occurred_at IS NOT excluded.occurred_at
        OR acquisition_events.payload IS NOT excluded.payload
        OR (?=1 AND acquisition_events.lead_id IS NOT excluded.lead_id)`)
      .bind(event.key,event.type,userId,event.leadId ?? leadId,event.occurredAt,Date.now(),stableJson(event.data),userId,expectedThrough,event.leadId ? 1 : 0)),
    env.DB.prepare('UPDATE acquisition_projection_accounts SET through_sequence=? WHERE user_id=? AND through_sequence=?')
      .bind(nextThrough,userId,expectedThrough),
  ];
  const results = await env.DB.batch(statements);
  return Boolean(results.at(-1)?.meta.changes);
}

export async function recordProductEventSafely(env: Env, event: ProductEvent): Promise<void> {
  if (env.ACQUISITION_ENABLED !== 'true' || !env.DB) return;
  try { await appendProductEvent(env, event); }
  catch { console.error('acquisition_event_write_failed'); }
}

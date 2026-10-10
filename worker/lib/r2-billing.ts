import { accountBillingRequest } from './prepaid-billing';
import { reserveStorage, storageMetered, storagePricing, storageCharging, STORAGE_DAY_MS } from './r2-storage';

export type StorageDailyRow = { day: string; user_id: string; app_id: string; peak_bytes: number; class_a: number; class_b: number;
  markup_bps: number; provider_nano_usd: number; cost_nano_usd: number; billable: number; settled: number };
const dayStart = (day: string) => Date.parse(`${day}T00:00:00Z`);
const dayName = (at: number) => new Date(at).toISOString().slice(0, 10);
export function dailyStorageCost(peakBytes: number, classA: number, classB: number, markupBps: number) {
  // Standard storage is decimal GB, daily peaks divided by 30. Use integer
  // nano-USD so sub-micro-dollar requests accumulate without per-request loss.
  const providerNanoUsd = Math.round(peakBytes / 2000 + classA * 4500 + classB * 360);
  const costNanoUsd = Math.round((peakBytes / 2000 + classA * 4500 + classB * 360) * (10000 + markupBps) / 10000);
  return { providerNanoUsd, costNanoUsd };
}
export async function finalizeStorageDay(env: Env, day: string) {
  const start = dayStart(day), end = start + STORAGE_DAY_MS, pricing = storagePricing(env);
  if (!Number.isFinite(start) || dayName(start) !== day || end > Date.now()) throw new Error('invalid_storage_day');
  const owners = await env.DB.prepare(`SELECT user_id,app_id FROM r2_object_events WHERE at<?
    UNION SELECT user_id,app_id FROM r2_operations WHERE started_at>=? AND started_at<?`).bind(end, start, end).all<{ user_id: string; app_id: string }>();
  for (const owner of owners.results) {
    const saved = await env.DB.prepare('SELECT day FROM r2_daily_usage WHERE day=? AND user_id=? AND app_id=?').bind(day, owner.user_id, owner.app_id).first();
    if (saved) continue;
    const peak = await env.DB.prepare(`WITH sizes AS (
      SELECT at,SUM(delta) OVER(ORDER BY at,sequence ROWS UNBOUNDED PRECEDING) AS bytes
      FROM r2_object_events WHERE user_id=? AND app_id=? AND at<?)
      SELECT MAX(0,COALESCE((SELECT SUM(delta) FROM r2_object_events WHERE user_id=? AND app_id=? AND at<?),0),
        COALESCE((SELECT MAX(bytes) FROM sizes WHERE at>=?),0)) AS bytes`).bind(owner.user_id, owner.app_id, end, owner.user_id, owner.app_id, start, start).first<{ bytes: number }>();
    const ops = await env.DB.prepare(`SELECT COALESCE(SUM(category='a'),0) AS a,COALESCE(SUM(category='b'),0) AS b,
      COALESCE(SUM(status<>'completed'),0) AS unknown FROM r2_operations WHERE user_id=? AND app_id=? AND started_at>=? AND started_at<?`)
      .bind(owner.user_id, owner.app_id, start, end).first<{ a: number; b: number; unknown: number }>();
    const cost = dailyStorageCost(peak!.bytes, ops!.a, ops!.b, pricing.markupBps);
    let billable = storageCharging(env, start) && owner.user_id !== 'mainbrella';
    if (billable) {
      const account = await accountBillingRequest<{ hasWallet: boolean }>(env, owner.user_id, '/billing/storage', { action: 'status' });
      // Unfunded legacy inventory is a platform expense until a wallet exists;
      // failed renewal still queues deletion rather than retaining it forever.
      billable = account.hasWallet;
    }
    const id = `r2:daily:${day}:${owner.user_id}:${owner.app_id}`;
    const evidence = JSON.stringify({ day, appId: owner.app_id, peakBytes: peak!.bytes, classA: ops!.a, classB: ops!.b,
      unknownOperations: ops!.unknown, providerNanoUsd: cost.providerNanoUsd, markupBps: pricing.markupBps, provisional: true });
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO r2_daily_usage(day,user_id,app_id,peak_bytes,class_a,class_b,markup_bps,provider_nano_usd,cost_nano_usd,billable)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(day,user_id,app_id) DO NOTHING`)
        .bind(day, owner.user_id, owner.app_id, peak!.bytes, ops!.a, ops!.b, pricing.markupBps, cost.providerNanoUsd, cost.costNanoUsd, billable ? 1 : 0),
      ...(billable ? [env.DB.prepare('INSERT INTO r2_receipts(id,user_id,app_id,occurred_at,cost_nano_usd,evidence) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING')
        .bind(id, owner.user_id, owner.app_id, end - 1, cost.costNanoUsd, evidence)] : []),
    ]);
  }
}
export async function settleStorageReceipts(env: Env) {
  const rows = await env.DB.prepare('SELECT * FROM r2_receipts WHERE settled=0 ORDER BY occurred_at,id LIMIT 100')
    .all<{ id: string; user_id: string; occurred_at: number; cost_nano_usd: number; evidence: string }>();
  for (const row of rows.results) {
    try {
      await accountBillingRequest(env, row.user_id, '/billing/storage', { action: 'settle', id: row.id, costNanoUsd: row.cost_nano_usd,
        occurredAt: row.occurred_at, evidence: JSON.parse(row.evidence) });
      await env.DB.batch([
        env.DB.prepare('UPDATE r2_receipts SET settled=1 WHERE id=?').bind(row.id),
        env.DB.prepare('UPDATE r2_daily_usage SET settled=1 WHERE day=? AND user_id=? AND app_id=?')
          .bind(JSON.parse(row.evidence).day ?? '', row.user_id, JSON.parse(row.evidence).appId),
      ]);
    } catch { console.error('storage_settlement_deferred', { receiptId: row.id }); }
  }
}
export async function runStorageBilling(env: Env) {
  if (!storageMetered(env)) return;
  const state = await env.DB.prepare("SELECT value FROM r2_meter_state WHERE id='settled_day'").first<{ value: string }>();
  const earliest = await env.DB.prepare(`SELECT MIN(at) AS at FROM (SELECT MIN(at) AS at FROM r2_object_events UNION ALL SELECT MIN(started_at) AS at FROM r2_operations)`).first<{ at: number | null }>();
  let start = state ? dayStart(state.value) + STORAGE_DAY_MS : Math.floor((earliest?.at ?? Date.now()) / STORAGE_DAY_MS) * STORAGE_DAY_MS;
  const today = Math.floor(Date.now() / STORAGE_DAY_MS) * STORAGE_DAY_MS;
  // Bounded catch-up, with a durable cursor; a cron outage loses no retained days.
  for (let count = 0; start < today && count < 7; count++, start += STORAGE_DAY_MS) {
    await finalizeStorageDay(env, dayName(start));
    await env.DB.prepare("INSERT INTO r2_meter_state(id,value) VALUES('settled_day',?) ON CONFLICT(id) DO UPDATE SET value=MAX(value,excluded.value)").bind(dayName(start)).run();
  }
  await settleStorageReceipts(env);
  if (storageCharging(env)) {
    const accounts = await env.DB.prepare(`SELECT user_id FROM r2_accounts WHERE user_id<>'mainbrella' ORDER BY user_id`).all<{ user_id: string }>();
    for (const row of accounts.results) {
      try { await reserveStorage(env, row.user_id); }
      catch { console.error('storage_renewal_deferred', { userId: row.user_id }); }
    }
  }
}

export type StorageInvoice = { id: string; month: string; evidenceReference: string;
  providerNanoUsd: { storage: number; classA: number; classB: number };
  additionalPlatformUsage: { byteDays: number; classA: number; classB: number } };
export function allocateStorageCategory(amount: number, weights: number[]): number[] {
  const total = weights.reduce((sum, value) => sum + BigInt(value), 0n);
  if (!total) { if (amount) throw new Error('storage_invoice_usage_missing'); return weights.map(() => 0); }
  const amounts = weights.map((value, index) => ({ index, amount: Number(BigInt(amount) * BigInt(value) / total), remainder: BigInt(amount) * BigInt(value) % total }));
  let remaining = amount - amounts.reduce((sum, row) => sum + row.amount, 0);
  for (const row of [...amounts].sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1)) {
    if (!remaining) break;
    row.amount++; remaining--;
  }
  return amounts.map(row => row.amount);
}
export async function reconcileStorageInvoice(env: Env, invoice: StorageInvoice) {
  if (!invoice || typeof invoice.month !== 'string' || typeof invoice.id !== 'string'
    || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(invoice.month) || !/^[A-Za-z0-9_-]{1,100}$/.test(invoice.id)
    || typeof invoice.evidenceReference !== 'string' || !invoice.evidenceReference.trim() || invoice.evidenceReference.length > 2000
    || !invoice.providerNanoUsd || !invoice.additionalPlatformUsage
    || Object.keys(invoice.providerNanoUsd).some(key => !['storage', 'classA', 'classB'].includes(key))
    || Object.keys(invoice.additionalPlatformUsage).some(key => !['byteDays', 'classA', 'classB'].includes(key))
    || [invoice.providerNanoUsd.storage, invoice.providerNanoUsd.classA, invoice.providerNanoUsd.classB,
      invoice.additionalPlatformUsage.byteDays, invoice.additionalPlatformUsage.classA, invoice.additionalPlatformUsage.classB]
      .some(value => !Number.isSafeInteger(value) || value < 0)
    || !Number.isSafeInteger(2 * (invoice.providerNanoUsd.storage + invoice.providerNanoUsd.classA + invoice.providerNanoUsd.classB))) throw new Error('invalid_request');
  // Normalize field order so HTTP JSON key order cannot change retry identity.
  invoice = { id: invoice.id, month: invoice.month, evidenceReference: invoice.evidenceReference,
    providerNanoUsd: { storage: invoice.providerNanoUsd.storage, classA: invoice.providerNanoUsd.classA, classB: invoice.providerNanoUsd.classB },
    additionalPlatformUsage: { byteDays: invoice.additionalPlatformUsage.byteDays, classA: invoice.additionalPlatformUsage.classA, classB: invoice.additionalPlatformUsage.classB } };
  const [year, month] = invoice.month.split('-').map(Number), end = Date.UTC(year, month, 1);
  if (end > Date.now()) throw new Error('month_not_finished');
  const input = JSON.stringify(invoice);
  const saved = await env.DB.prepare('SELECT evidence FROM r2_invoices WHERE month=? OR id=?').bind(invoice.month, invoice.id).first<{ evidence: string }>();
  if (saved) {
    const result = JSON.parse(saved.evidence);
    if (JSON.stringify(result.invoice) !== input) throw new Error('storage_invoice_conflict');
    return result;
  }
  const cursor = await env.DB.prepare("SELECT value FROM r2_meter_state WHERE id='settled_day'").first<{ value: string }>();
  if (!cursor || cursor.value < dayName(end - 1)) throw new Error('storage_metering_incomplete');
  const pending = await env.DB.prepare("SELECT COUNT(*) AS count FROM r2_receipts WHERE id LIKE 'r2:daily:' || ? || '%' AND settled=0").bind(invoice.month).first<{ count: number }>();
  if (pending!.count) throw new Error('storage_settlement_pending');
  const { results: rows } = await env.DB.prepare('SELECT * FROM r2_daily_usage WHERE day LIKE ? ORDER BY day,user_id,app_id').bind(`${invoice.month}-%`).all<StorageDailyRow>();
  const a = allocateStorageCategory(invoice.providerNanoUsd.classA, [...rows.map(row => row.class_a), invoice.additionalPlatformUsage.classA]);
  const b = allocateStorageCategory(invoice.providerNanoUsd.classB, [...rows.map(row => row.class_b), invoice.additionalPlatformUsage.classB]);
  const storage = allocateStorageCategory(invoice.providerNanoUsd.storage, [...rows.map(row => row.peak_bytes), invoice.additionalPlatformUsage.byteDays]);
  const allocations = new Map<string, { userId: string; appId: string; providerNanoUsd: number; markupNanoUsd: number; costNanoUsd: number; provisionalNanoUsd: number; adjustmentNanoUsd: number }>();
  const markupWeights = new Map<string, bigint>();
  let platformNanoUsd = a.at(-1)! + b.at(-1)! + storage.at(-1)!;
  rows.forEach((row, index) => {
    const provider = a[index] + b[index] + storage[index];
    if (!row.billable || row.user_id === 'mainbrella') { platformNanoUsd += provider; return; }
    const id = `${row.user_id}:${row.app_id}`, value = allocations.get(id) ?? { userId: row.user_id, appId: row.app_id, providerNanoUsd: 0, markupNanoUsd: 0, costNanoUsd: 0, provisionalNanoUsd: 0, adjustmentNanoUsd: 0 };
    value.providerNanoUsd += provider;
    markupWeights.set(id, (markupWeights.get(id) ?? 0n) + BigInt(provider) * BigInt(row.markup_bps));
    value.provisionalNanoUsd += row.cost_nano_usd;
    allocations.set(id, value);
  });
  for (const [id, row] of allocations) {
    row.markupNanoUsd = Number((markupWeights.get(id)! + 5000n) / 10000n);
    row.costNanoUsd = row.providerNanoUsd + row.markupNanoUsd;
    row.adjustmentNanoUsd = row.costNanoUsd - row.provisionalNanoUsd;
  }
  const result = { invoice, platformNanoUsd, allocations: [...allocations.values()] }, at = Date.now();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO r2_invoices(id,month,evidence,created_at) VALUES(?,?,?,?)').bind(invoice.id, invoice.month, JSON.stringify(result), at),
    ...result.allocations.map(row => env.DB.prepare('INSERT INTO r2_receipts(id,user_id,app_id,occurred_at,cost_nano_usd,evidence) VALUES(?,?,?,?,?,?)')
      .bind(`r2:invoice:${invoice.id}:${row.userId}:${row.appId}`, row.userId, row.appId, at, row.adjustmentNanoUsd,
        JSON.stringify({ adjustment: true, month: invoice.month, invoiceId: invoice.id, ...row }))),
  ]);
  return result;
}

export async function storageBillingSummary(env: Env, userId: string) {
  const pricing = storagePricing(env), month = new Date().toISOString().slice(0, 7);
  const { results: projects } = await env.DB.prepare(`SELECT app_id AS appId,MAX(a.name) AS name,
    SUM(CASE WHEN o.state='live' AND o.deleted_at IS NULL THEN o.size ELSE 0 END) AS storedBytes,
    SUM(CASE WHEN o.state='live' AND o.deleted_at IS NULL AND o.purpose<>'history' THEN o.size ELSE 0 END) AS sourceAssetsBytes,
    SUM(CASE WHEN o.state='live' AND o.deleted_at IS NULL AND o.purpose='history' THEN o.size ELSE 0 END) AS historyBytes
    FROM r2_objects o LEFT JOIN build_apps a ON a.id=o.app_id AND a.user_id=o.user_id WHERE o.user_id=? GROUP BY o.app_id ORDER BY name,app_id`)
    .bind(userId).all<{ appId: string; name: string | null; storedBytes: number; sourceAssetsBytes: number; historyBytes: number }>();
  const account = await env.DB.prepare('SELECT funded_through,writes_blocked,max_bytes FROM r2_accounts WHERE user_id=?').bind(userId).first<{ funded_through: number | null; writes_blocked: number; max_bytes: number }>();
  const values = [];
  for (const project of projects) {
    const usage = await env.DB.prepare(`SELECT COALESCE(SUM(provider_nano_usd),0) AS provider,COALESCE(SUM(cost_nano_usd),0) AS estimated,
      COALESCE(SUM(class_a),0) AS a,COALESCE(SUM(class_b),0) AS b FROM r2_daily_usage WHERE user_id=? AND app_id=? AND day LIKE ?`).bind(userId, project.appId, `${month}-%`).first<{ provider: number; estimated: number; a: number; b: number }>();
    const charged = await env.DB.prepare(`SELECT COALESCE(SUM(CASE WHEN settled=1 THEN cost_nano_usd ELSE 0 END),0) AS cost,
      COALESCE(SUM(CASE WHEN json_extract(evidence,'$.adjustment')=1 THEN cost_nano_usd ELSE 0 END),0) AS adjustment
      FROM r2_receipts WHERE user_id=? AND app_id=? AND occurred_at>=?`)
      .bind(userId, project.appId, dayStart(`${month}-01`)).first<{ cost: number; adjustment: number }>();
    const todayOps = await env.DB.prepare(`SELECT COALESCE(SUM(category='a'),0) AS a,COALESCE(SUM(category='b'),0) AS b FROM r2_operations
      WHERE user_id=? AND app_id=? AND started_at>=?`).bind(userId, project.appId, Math.floor(Date.now() / STORAGE_DAY_MS) * STORAGE_DAY_MS).first<{ a: number; b: number }>();
    values.push({ ...project, chargedCents: charged!.cost / 10000000,
      estimatedMonthlyCents: project.storedBytes / 1e9 * 1.5 * (1 + pricing.markupBps / 10000),
      cloudflareCents: usage!.provider / 10000000, markupCents: (usage!.estimated - usage!.provider) / 10000000,
      adjustmentCents: charged!.adjustment / 10000000, writes: usage!.a + todayOps!.a, reads: usage!.b + todayOps!.b,
      fundedThrough: account?.funded_through ?? null, writesBlocked: Boolean(account?.writes_blocked) });
  }
  return { month, pricing, maxBytes: account?.max_bytes ?? pricing.maxBytes, projects: values };
}

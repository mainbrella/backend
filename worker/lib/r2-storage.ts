import { accountBillingRequest } from './prepaid-billing';

export type StorageOwner = { userId: string; appId: string };
export type StoragePurpose = 'source' | 'assets' | 'history' | 'diagnostics' | 'platform';
export const PLATFORM_STORAGE: StorageOwner = { userId: 'mainbrella', appId: 'platform' };
export const STORAGE_DAY_MS = 86400000;
export const STORAGE_RETENTION_DAYS = 7;
export function storagePricing(env: Env) {
  const markupBps = Number(env.R2_MARKUP_BPS ?? 2000);
  const maxBytes = Number(env.R2_ACCOUNT_MAX_BYTES ?? 10000000000);
  const chargeFrom = env.R2_CHARGE_FROM ? Date.parse(env.R2_CHARGE_FROM) : null;
  if (!Number.isSafeInteger(markupBps) || markupBps < 0 || markupBps > 10000
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || (chargeFrom !== null && (!Number.isFinite(chargeFrom) || chargeFrom % STORAGE_DAY_MS !== 0))
    || !['off', 'meter', 'charge'].includes(env.R2_BILLING_MODE ?? 'off')
    || env.R2_BILLING_MODE === 'charge' && chargeFrom === null) throw new Error('invalid_storage_configuration');
  return { mode: env.R2_BILLING_MODE ?? 'off', markupBps, maxBytes, chargeFrom,
    storageUsdPerGbMonth: 0.015, classAUsdPerMillion: 4.5, classBUsdPerMillion: 0.36, retentionDays: STORAGE_RETENTION_DAYS };
}
export const storageMetered = (env: Env) => storagePricing(env).mode !== 'off';
export const storageCharging = (env: Env, at = Date.now()) => {
  const pricing = storagePricing(env);
  return pricing.mode === 'charge' && at >= pricing.chargeFrom!;
};
export const storageRetentionNanoUsd = (bytes: number, markupBps: number) => Math.ceil(bytes * 0.0005 * STORAGE_RETENTION_DAYS * (1 + markupBps / 10000));

function ownedKey(owner: StorageOwner, key: string) {
  if (owner.userId !== 'mainbrella' && !key.startsWith(`build-git/${owner.userId}/${owner.appId}/`)) throw new Error('storage_owner_mismatch');
}
async function operation<T>(env: Env, owner: StorageOwner, name: 'put' | 'get' | 'head' | 'list' | 'delete', action: () => Promise<T>): Promise<T> {
  if (!storageMetered(env)) return action();
  const id = crypto.randomUUID();
  // An attempt identity belongs to a provider request, never to a billing retry.
  // Unknown outcomes remain evidence and are resolved against the invoice.
  await env.DB.prepare(`INSERT INTO r2_operations(id,user_id,app_id,operation,category,started_at) VALUES(?,?,?,?,?,?)`)
    .bind(id, owner.userId, owner.appId, name, name === 'delete' ? 'free' : name === 'put' || name === 'list' ? 'a' : 'b', Date.now()).run();
  let value: T;
  try { value = await action(); }
  catch (error) {
    await env.DB.prepare("UPDATE r2_operations SET status='unknown' WHERE id=?").bind(id).run();
    throw error;
  }
  await env.DB.prepare("UPDATE r2_operations SET status='completed' WHERE id=?").bind(id).run();
  return value;
}
export async function reserveStorage(env: Env, userId: string, projected = { bytes: 0, writes: 1, requireFunding: false }) {
  if ((!projected.requireFunding && !storageCharging(env)) || userId === 'mainbrella') return null;
  const pricing = storagePricing(env);
  const ready = await env.DB.prepare("SELECT value FROM r2_meter_state WHERE id='inventory_complete'").first();
  if (!ready && storageMetered(env)) throw new Error('storage_metering_incomplete');
  const row = await env.DB.prepare('SELECT COALESCE(SUM(size),0) AS bytes FROM r2_objects WHERE user_id=? AND deleted_at IS NULL').bind(userId).first<{ bytes: number }>();
  const today = Math.floor(Date.now() / STORAGE_DAY_MS) * STORAGE_DAY_MS;
  const peak = await env.DB.prepare(`WITH sizes AS(SELECT app_id,at,delta,
    SUM(delta) OVER(PARTITION BY app_id ORDER BY at,sequence ROWS UNBOUNDED PRECEDING) AS bytes FROM r2_object_events WHERE user_id=?)
    SELECT COALESCE(SUM(peak),0) AS bytes FROM(SELECT app_id,
      MAX(COALESCE(MAX(CASE WHEN at>=? THEN MAX(bytes,bytes-delta) END),0),SUM(delta)) AS peak FROM sizes GROUP BY app_id)`)
    .bind(userId, today).first<{ bytes: number }>();
  const operations = await env.DB.prepare(`SELECT COALESCE(SUM(CASE WHEN category='a' THEN 4500 WHEN category='b' THEN 360 ELSE 0 END),0) AS nano FROM r2_operations o
    WHERE user_id=? AND NOT EXISTS(SELECT 1 FROM r2_daily_usage d WHERE d.user_id=o.user_id AND d.app_id=o.app_id AND d.day=strftime('%Y-%m-%d',o.started_at/1000,'unixepoch'))`).bind(userId).first<{ nano: number }>();
  const bytes = row!.bytes + projected.bytes;
  let result: { fundedThrough: number | null; writesBlocked: boolean };
  try { result = await accountBillingRequest<{ fundedThrough: number | null; writesBlocked: boolean }>(env, userId, '/billing/storage', {
    action: 'reserve', bytes, retentionNanoUsd: storageRetentionNanoUsd(bytes, pricing.markupBps)
      + Math.ceil((operations!.nano + 4500 * projected.writes + Math.max(peak!.bytes, bytes) / 2000) * (1 + pricing.markupBps / 10000)), retentionDays: STORAGE_RETENTION_DAYS,
  }); } catch (error) {
    if (!(error instanceof Error) || !['insufficient_balance', 'spend_limit_exceeded'].includes(error.message)) throw error;
    const saved = await env.DB.prepare('SELECT funded_through FROM r2_accounts WHERE user_id=?').bind(userId).first<{ funded_through: number | null }>();
    result = { fundedThrough: saved?.funded_through ?? null, writesBlocked: true };
  }
  await env.DB.prepare('UPDATE r2_accounts SET funded_through=?,writes_blocked=? WHERE user_id=?').bind(result.fundedThrough, result.writesBlocked ? 1 : 0, userId).run();
  return result;
}
export async function inventoryObject(env: Env, owner: StorageOwner, key: string, size: number, purpose: StoragePurpose, at = Date.now(), state: 'live' | 'pending' = 'live') {
  if (!storageMetered(env)) return;
  const maxBytes = storagePricing(env).maxBytes;
  await env.DB.prepare('INSERT INTO r2_accounts(user_id,max_bytes) VALUES(?,?) ON CONFLICT(user_id) DO NOTHING').bind(owner.userId, maxBytes).run();
  await env.DB.prepare(`INSERT INTO r2_objects(key,user_id,app_id,purpose,size,state,created_at,updated_at)
    SELECT ?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM r2_objects WHERE key=?)`)
    .bind(key, owner.userId, owner.appId, purpose, size, state, at, at, key).run();
  const existing = await env.DB.prepare('SELECT user_id,app_id,size FROM r2_objects WHERE key=?').bind(key).first<{ user_id: string; app_id: string; size: number }>();
  if (!existing || existing.user_id !== owner.userId || existing.app_id !== owner.appId || existing.size !== size) throw new Error('storage_object_conflict');
  if (state === 'pending') await env.DB.prepare("UPDATE r2_objects SET state='pending',deleted_at=NULL,created_at=?,updated_at=? WHERE key=? AND deleted_at IS NOT NULL").bind(at, at, key).run();
  if (state === 'live') await env.DB.prepare("UPDATE r2_objects SET state='live',deleted_at=NULL,updated_at=? WHERE key=? AND (state='pending' OR deleted_at IS NOT NULL)").bind(at, key).run();
}
export async function acquireStorageLock(env: Env, appId: string) {
  const token = crypto.randomUUID(), now = Date.now();
  const row = await env.DB.prepare(`INSERT INTO r2_project_locks(app_id,token,expires_at) VALUES(?,?,?)
    ON CONFLICT(app_id) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at WHERE r2_project_locks.expires_at<=? RETURNING token`)
    .bind(appId, token, now + 600000, now).first<{ token: string }>();
  if (row?.token !== token) throw new Error('storage_busy');
  return token;
}
export const releaseStorageLock = (env: Env, appId: string, token: string) => env.DB.prepare('DELETE FROM r2_project_locks WHERE app_id=? AND token=?').bind(appId, token).run();
export async function putStoredObject(env: Env, owner: StorageOwner, key: string, value: string | ArrayBuffer | Uint8Array<ArrayBuffer>, purpose: StoragePurpose, options?: R2PutOptions) {
  if (!storageMetered(env)) return putObject(env, owner, key, value, purpose, options);
  const token = await acquireStorageLock(env, owner.appId);
  try {
    const user = await env.DB.prepare('SELECT id FROM users WHERE id=?').bind(owner.userId).first();
    if (!user && owner.userId !== 'mainbrella') throw new Error('storage_owner_unavailable');
    const deletion = await env.DB.prepare('SELECT app_id FROM build_git_deletions WHERE app_id=?').bind(owner.appId).first();
    if (deletion) throw new Error('storage_retention_expired');
    return await putObject(env, owner, key, value, purpose, options);
  } finally { await releaseStorageLock(env, owner.appId, token); }
}
async function putObject(env: Env, owner: StorageOwner, key: string, value: string | ArrayBuffer | Uint8Array<ArrayBuffer>, purpose: StoragePurpose, options?: R2PutOptions) {
  ownedKey(owner, key);
  if (!env.BUCKET) throw new Error('storage_unavailable');
  const size = typeof value === 'string' ? new TextEncoder().encode(value).length : value.byteLength;
  if (storageMetered(env)) {
    await inventoryObject(env, owner, key, size, purpose, Date.now(), 'pending');
    try {
      const hold = await reserveStorage(env, owner.userId);
      if (hold?.writesBlocked) throw new Error('storage_funding_required');
    } catch (error) {
      await env.DB.prepare("UPDATE r2_objects SET deleted_at=? WHERE key=? AND state='pending'").bind(Date.now(), key).run();
      throw error;
    }
  }
  const result = await operation(env, owner, 'put', () => env.BUCKET!.put(key, value, options));
  // Conditional puts that return null still made a provider operation; the
  // immutable key already exists and is counted only once in the inventory.
  await inventoryObject(env, owner, key, size, purpose);
  return result;
}
export async function getStoredObject(env: Env, owner: StorageOwner, key: string) {
  ownedKey(owner, key);
  return operation(env, owner, 'get', () => env.BUCKET!.get(key));
}
export async function headStoredObject(env: Env, owner: StorageOwner, key: string) {
  ownedKey(owner, key);
  return operation(env, owner, 'head', () => env.BUCKET!.head(key));
}
export async function listStoredObjects(env: Env, owner: StorageOwner, options: R2ListOptions) {
  if (owner.userId !== 'mainbrella') ownedKey(owner, options.prefix ?? '');
  return operation(env, owner, 'list', () => env.BUCKET!.list(options));
}
export async function deleteStoredObjects(env: Env, owner: StorageOwner, keys: string[]) {
  if (!keys.length) return;
  keys.forEach(key => ownedKey(owner, key));
  await operation(env, owner, 'delete', () => env.BUCKET!.delete(keys));
  if (storageMetered(env)) for (const key of keys) await env.DB.prepare('UPDATE r2_objects SET deleted_at=?,updated_at=? WHERE key=? AND deleted_at IS NULL')
    .bind(Date.now(), Date.now(), key).run();
}

/** Fund the entire immutable commit before uploading any of it. Existing keys
 * consume no additional bytes, but conditional puts still incur write costs. */
export async function reserveStorageCommit(env: Env, owner: StorageOwner, objects: { key: string; size: number }[], writes = objects.length) {
  const unique = new Map(objects.map(object => [object.key, object.size]));
  let bytes = 0;
  for (const [key, size] of unique) {
    ownedKey(owner, key);
    const existing = await env.DB.prepare('SELECT size FROM r2_objects WHERE key=? AND deleted_at IS NULL').bind(key).first<{ size: number }>();
    if (existing && existing.size !== size) throw new Error('storage_object_conflict');
    if (!existing) bytes += size;
  }
  const held = await reserveStorage(env, owner.userId, { bytes, writes, requireFunding: true });
  if (held?.writesBlocked) throw new Error('storage_funding_required');
}

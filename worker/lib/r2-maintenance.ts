import type { RetentionRow, ProductStorageExpiration } from './r2-retention';
import { inventoryObject, listStoredObjects, PLATFORM_STORAGE, storageCharging, storageMetered, STORAGE_DAY_MS } from './r2-storage';

export async function inventoryStoragePage(env: Env) {
  if (!storageMetered(env) || !env.BUCKET) return;
  const state = await env.DB.prepare("SELECT value FROM r2_meter_state WHERE id='inventory'").first<{ value: string }>();
  const saved = state ? JSON.parse(state.value) as { cursor?: string; nextAt?: number } : {};
  if ((saved.nextAt ?? 0) > Date.now()) return;
  const page = await listStoredObjects(env, PLATFORM_STORAGE, { limit: 500, cursor: saved.cursor, include: ['httpMetadata'] });
  for (const object of page.objects) {
    const match = /^build-git\/([^/]+)\/([^/]+)\/(objects|parts|bundles)\//.exec(object.key);
    const product = /^products\/([a-z][a-z0-9_-]{0,31})\/([A-Za-z0-9_-]{1,128})\/([A-Za-z0-9_-]{1,128})\//.exec(object.key);
    const owner = match ? { userId: match[1], appId: match[2] }
      : product ? { product: product[1], userId: product[2], appId: product[3] } : PLATFORM_STORAGE;
    const purpose = product ? 'assets' : !match ? 'platform' : match[3] === 'objects' ? object.httpMetadata?.contentType?.startsWith('image/') ? 'assets' : 'source' : 'history';
    await inventoryObject(env, owner, object.key, object.size, purpose);
  }
  if (!page.truncated) await env.DB.prepare("INSERT INTO r2_meter_state(id,value) VALUES('inventory_complete',?) ON CONFLICT(id) DO NOTHING").bind(String(Date.now())).run();
  await env.DB.prepare("INSERT INTO r2_meter_state(id,value) VALUES('inventory',?) ON CONFLICT(id) DO UPDATE SET value=excluded.value")
    .bind(JSON.stringify(page.truncated ? { cursor: page.cursor } : { nextAt: Date.now() + STORAGE_DAY_MS })).run();
}

export async function expireUnfundedStorage(env: Env, productExpiration: ProductStorageExpiration) {
  if (!storageCharging(env)) return;
  const { expireStorageAccount, finishStorageExpiration } = await import('./r2-retention');
  const unfinished = await env.DB.prepare('SELECT user_id,expiration_token FROM r2_accounts WHERE expired_at IS NOT NULL AND expiration_token IS NOT NULL LIMIT 20')
    .all<{ user_id: string; expiration_token: string }>();
  for (const row of unfinished.results) {
    try { await finishStorageExpiration(env, row.user_id, row.expiration_token); }
    catch { console.error('storage_expiration_finish_deferred', { userId: row.user_id }); }
  }
  const cursor = await env.DB.prepare("SELECT value FROM r2_meter_state WHERE id='expiry_cursor'").first<{ value: string }>();
  const rows = await env.DB.prepare(`SELECT a.* FROM r2_accounts a WHERE a.writes_blocked=1 AND a.expired_at IS NULL
    AND a.delete_after<=? AND a.warned_at IS NOT NULL AND a.user_id>?
    AND NOT EXISTS(SELECT 1 FROM r2_receipts r WHERE r.user_id=a.user_id AND r.settled=0) ORDER BY a.user_id LIMIT 20`)
    .bind(Date.now(), cursor?.value ?? '').all<RetentionRow>();
  for (const row of rows.results) {
    try { await expireStorageAccount(env, row, productExpiration); }
    catch { console.error('storage_expiration_deferred', { userId: row.user_id }); }
  }
  await env.DB.prepare("INSERT INTO r2_meter_state(id,value) VALUES('expiry_cursor',?) ON CONFLICT(id) DO UPDATE SET value=excluded.value")
    .bind(rows.results.length === 20 ? rows.results.at(-1)!.user_id : '').run();
}

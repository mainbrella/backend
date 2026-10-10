import { buildContentHash } from './build-storage';
import { BUILD_GIT_IGNORE } from './build-git';
import { readBuildGitBundle, type BuildGitBundle } from './build-git-bundle';
import { deleteStoredObjects, getStoredObject, headStoredObject, inventoryObject, listStoredObjects, PLATFORM_STORAGE,
  acquireStorageLock, releaseStorageLock, storageCharging, storageMetered, STORAGE_DAY_MS, type StorageOwner } from './r2-storage';

export async function inventoryStoragePage(env: Env) {
  if (!storageMetered(env) || !env.BUCKET) return;
  const state = await env.DB.prepare("SELECT value FROM r2_meter_state WHERE id='inventory'").first<{ value: string }>();
  const saved = state ? JSON.parse(state.value) as { cursor?: string; nextAt?: number } : {};
  if ((saved.nextAt ?? 0) > Date.now()) return;
  const page = await listStoredObjects(env, PLATFORM_STORAGE, { limit: 500, cursor: saved.cursor, include: ['httpMetadata'] });
  for (const object of page.objects) {
    const match = /^build-git\/([^/]+)\/([^/]+)\/(objects|parts|bundles)\//.exec(object.key);
    const owner = match ? { userId: match[1], appId: match[2] } : PLATFORM_STORAGE;
    const purpose = !match ? 'platform' : match[3] === 'objects' ? object.httpMetadata?.contentType?.startsWith('image/') ? 'assets' : 'source' : 'history';
    await inventoryObject(env, owner, object.key, object.size, purpose);
  }
  if (!page.truncated) await env.DB.prepare("INSERT INTO r2_meter_state(id,value) VALUES('inventory_complete',?) ON CONFLICT(id) DO NOTHING").bind(String(Date.now())).run();
  await env.DB.prepare("INSERT INTO r2_meter_state(id,value) VALUES('inventory',?) ON CONFLICT(id) DO UPDATE SET value=excluded.value")
    .bind(JSON.stringify(page.truncated ? { cursor: page.cursor } : { nextAt: Date.now() + STORAGE_DAY_MS })).run();
}

async function referencedObjects(env: Env, owner: StorageOwner) {
  const keys = new Set<string>(), manifests = new Set<string>();
  const rows = await env.DB.prepare(`SELECT source_json AS value FROM build_apps WHERE id=? AND user_id=?
    UNION ALL SELECT source_json FROM build_revisions WHERE app_id=?
    UNION ALL SELECT data FROM build_images WHERE app_id=?
    UNION ALL SELECT source_json FROM build_git_versions WHERE app_id=?
    UNION ALL SELECT lockfile FROM build_git_versions WHERE app_id=? AND lockfile IS NOT NULL
    UNION ALL SELECT result_json FROM build_operations WHERE turn_id IN(SELECT id FROM build_turns WHERE app_id=?) AND result_json IS NOT NULL
    UNION ALL SELECT source_json FROM build_operations WHERE turn_id IN(SELECT id FROM build_turns WHERE app_id=?) AND source_json IS NOT NULL`)
    .bind(owner.appId, owner.userId, ...Array(6).fill(owner.appId)).all<{ value: string }>();
  for (const row of rows.results) {
    try {
      const ref = JSON.parse(row.value);
      if (typeof ref?.$r2 === 'string') { keys.add(ref.$r2); manifests.add(ref.$r2); }
    } catch { /* Legacy inline source and image data. */ }
  }
  const bundles = await env.DB.prepare('SELECT DISTINCT bundle_key FROM build_git_versions WHERE app_id=?').bind(owner.appId).all<{ bundle_key: string }>();
  if (bundles.results.length) keys.add(`build-git/${owner.userId}/${owner.appId}/objects/${await buildContentHash(new TextEncoder().encode(BUILD_GIT_IGNORE))}`);
  const history = new Map<string, BuildGitBundle>();
  for (const row of bundles.results) {
    let key: string | null = row.bundle_key, child: BuildGitBundle | undefined;
    const path = new Set<string>();
    while (key !== null) {
      if (path.has(key)) throw new Error('storage_reference_unavailable');
      path.add(key);
      const cached = history.get(key), bundle: BuildGitBundle = cached ?? await readBuildGitBundle(env, owner, key);
      if (child?.schemaVersion === 2 && bundle.schemaVersion === 2 && child.prerequisiteCommitId !== bundle.commitId)
        throw new Error('storage_reference_unavailable');
      if (cached) break;
      history.set(key, bundle); keys.add(key);
      for (const part of bundle.parts) keys.add(part.key);
      child = bundle;
      key = bundle.schemaVersion === 2 ? bundle.previousBundleKey : null;
    }
  }
  // Inspect only referenced manifest objects. Any missing/corrupt manifest
  // aborts cleanup; uncertain reachability must never cause data deletion.
  for (const key of manifests) {
    const object = await getStoredObject(env, PLATFORM_STORAGE, key);
    if (!object) throw new Error('storage_reference_unavailable');
    let value: { files?: { $r2: string }[]; parts?: { key: string }[]; schemaVersion?: number };
    try { value = await object.json(); } catch { continue; }
    if (value?.schemaVersion !== 1) continue;
    for (const file of value.files ?? []) keys.add(file.$r2);
    for (const part of value.parts ?? []) keys.add(part.key);
  }
  return keys;
}

export async function cleanupStorageOrphans(env: Env) {
  if (!storageMetered(env) || !env.BUCKET) return;
  const state = await env.DB.prepare("SELECT value FROM r2_meter_state WHERE id='orphan_app'").first<{ value: string }>();
  const page = await env.DB.prepare(`SELECT DISTINCT user_id,app_id FROM r2_objects WHERE deleted_at IS NULL AND user_id<>'mainbrella'
    AND app_id>? ORDER BY app_id LIMIT 10`).bind(state?.value ?? '').all<{ user_id: string; app_id: string }>();
  for (const row of page.results) {
    try {
      const owner = { userId: row.user_id, appId: row.app_id };
      const app = await env.DB.prepare('SELECT active_turn_id FROM build_apps WHERE id=? AND user_id=?').bind(owner.appId, owner.userId).first<{ active_turn_id: string | null }>();
      if (app?.active_turn_id) continue;
      const cutoff = Date.now() - STORAGE_DAY_MS;
      const candidates = await env.DB.prepare('SELECT key,state,size,purpose FROM r2_objects WHERE user_id=? AND app_id=? AND deleted_at IS NULL AND updated_at<? LIMIT 200')
        .bind(owner.userId, owner.appId, cutoff).all<{ key: string; state: string; size: number; purpose: 'source' | 'assets' | 'history' | 'diagnostics' }>();
      if (!candidates.results.length) continue;
      const refs = app ? await referencedObjects(env, owner) : new Set<string>();
      // New turns can begin while manifest reads are in flight. The write path
      // and this cleanup share a durable project lock, and writes fail closed.
      const token = await acquireStorageLock(env, owner.appId);
      try {
        const active = await env.DB.prepare('SELECT active_turn_id FROM build_apps WHERE id=?').bind(owner.appId).first<{ active_turn_id: string | null }>();
        if (active?.active_turn_id) continue;
        const currentRefs = app ? await referencedObjects(env, owner) : refs;
        for (const object of candidates.results) {
          if (object.state === 'pending') {
            const physical = await headStoredObject(env, PLATFORM_STORAGE, object.key);
            if (physical) await inventoryObject(env, owner, object.key, physical.size, object.purpose);
          }
          if (currentRefs.has(object.key)) {
            continue;
          }
          await deleteStoredObjects(env, PLATFORM_STORAGE, [object.key]);
        }
      } finally { await releaseStorageLock(env, owner.appId, token); }
    } catch { console.error('storage_orphan_cleanup_deferred', { appId: row.app_id }); }
  }
  await env.DB.prepare("INSERT INTO r2_meter_state(id,value) VALUES('orphan_app',?) ON CONFLICT(id) DO UPDATE SET value=excluded.value")
    .bind(page.results.length === 10 ? page.results.at(-1)!.app_id : '').run();
}

export async function expireUnfundedStorage(env: Env) {
  if (!storageCharging(env)) return;
  const rows = await env.DB.prepare(`SELECT a.user_id FROM r2_accounts a WHERE a.writes_blocked=1 AND (a.funded_through IS NULL OR a.funded_through<=?)
    AND NOT EXISTS(SELECT 1 FROM r2_receipts r WHERE r.user_id=a.user_id AND r.settled=0) LIMIT 20`).bind(Date.now()).all<{ user_id: string }>();
  for (const row of rows.results) {
    // Fence agents before removing the database references. The durable queue
    // owns physical deletion, including after account records are gone.
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO build_git_deletions(app_id,user_id,created_at) SELECT id,user_id,? FROM build_apps WHERE user_id=? ON CONFLICT(app_id) DO NOTHING`).bind(new Date().toISOString(), row.user_id),
      env.DB.prepare("UPDATE build_turns SET status='failed',error='storage_retention_expired',finished_at=? WHERE user_id=? AND status IN ('queued','running')").bind(new Date().toISOString(), row.user_id),
      env.DB.prepare("UPDATE build_operations SET source_json=NULL,result_json=NULL WHERE turn_id IN(SELECT id FROM build_turns WHERE user_id=?)").bind(row.user_id),
      env.DB.prepare('DELETE FROM build_git_versions WHERE app_id IN(SELECT id FROM build_apps WHERE user_id=?)').bind(row.user_id),
      env.DB.prepare('DELETE FROM build_revisions WHERE app_id IN(SELECT id FROM build_apps WHERE user_id=?)').bind(row.user_id),
      env.DB.prepare('DELETE FROM build_images WHERE app_id IN(SELECT id FROM build_apps WHERE user_id=?)').bind(row.user_id),
      env.DB.prepare("UPDATE build_apps SET source_json='{}',git_version_id=NULL,verified_git_version_id=NULL,active_turn_id=NULL WHERE user_id=?").bind(row.user_id),
    ]);
  }
}

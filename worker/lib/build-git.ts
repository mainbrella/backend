import { putStoredObject, getStoredObject, listStoredObjects, deleteStoredObjects, storageMetered, acquireStorageLock, releaseStorageLock, reserveStorageCommit } from './r2-storage';
import { BuildError, ownedBuildApp, validateBuildFiles, type BuildFiles, type BuildParams, type BuildTurnRow } from './build-contract';
import { buildImageBytes, buildImagePath, savedBuildImages, buildImageEntries } from './build-images';
import { buildGitProgram, BUILD_GIT_MAX_FILE_BYTES } from './build-git-program';
import { buildGitPrefix, gitCommitId, readBuildGitChain, validateBuildGitBundle, type BuildGitBundle, type BuildGitPart } from './build-git-bundle';
import { exportBuildGitBundles } from './build-git-export';
import { storeBuildSource, storeBuildText, storeBuildObject, buildSourceEntries, buildTextEntry, buildObjectRef, buildObjectReference, buildSourceManifest, type BuildStorageOwner, type BuildStoredFile } from './build-storage';

export const BUILD_GIT_ROOT = '/workspace/mainbrella-git';
export const BUILD_GIT_IGNORE = 'node_modules/\ndist/\n.env\n.env.*\n';
export type BuildGitVersion = {
  id: string; app_id: string; parent_version_id: string | null; commit_id: string; bundle_key: string;
  source_json: string; lockfile: string | null; assets_json: string; message: string; verified: number; created_at: string;
};
export type BuildGitRuntime = {
  run(label: string, command: string): Promise<{ status: string; stdout: string; stderr: string }>;
  write(path: string, content: string | Uint8Array<ArrayBuffer>): Promise<void>;
  read(path: string): Promise<Response>;
  persist(label: string, action: () => Promise<void>): Promise<void>;
};
type PreparedBuildGit = { commitId: string | null; bundleKey: string | null; bundles: BuildGitBundle[]; reuse: boolean };
export const buildGitVersion = (env: Env, appId: string, id: string) => env.DB.prepare('SELECT * FROM build_git_versions WHERE app_id = ? AND id = ?').bind(appId, id).first<BuildGitVersion>();
export const publicGitVersion = (version: BuildGitVersion) => ({ id: version.id, commitId: version.commit_id,
  parentVersionId: version.parent_version_id, message: version.message, verified: Boolean(version.verified), createdAt: version.created_at });

async function readBundle(env: Env, userId: string, appId: string, version: BuildGitVersion) {
  const owner = { userId, appId };
  if (!env.BUCKET || !version.bundle_key.startsWith(buildGitPrefix(owner)) || !gitCommitId(version.commit_id)) throw new BuildError('build_git_unavailable');
  // A previous full-history bundle may have been compacted after this caller
  // loaded its version row. Resolve the current immutable backing bundle.
  const current = await buildGitVersion(env, appId, version.id);
  if (!current) throw new BuildError('build_git_unavailable');
  return { commitId: version.commit_id, bundleKey: current.bundle_key, bundles: await readBuildGitChain(env, owner, current.bundle_key) };
}
async function prepare(env: Env, params: BuildParams, runtime: BuildGitRuntime, parent: BuildGitVersion | null, label: string, reuse = false): Promise<PreparedBuildGit> {
  const result = await runtime.run(`${label}-directories`, `mkdir -p ${BUILD_GIT_ROOT}/parts ${BUILD_GIT_ROOT}/snapshot /workspace/app`);
  if (result.status !== 'succeeded') throw new BuildError('build_git_unavailable');
  await runtime.write(`${BUILD_GIT_ROOT}/git.cjs`, buildGitProgram);
  if (reuse) {
    // Use only the platform's repository, scoped to this app and build turn.
    // Application scripts can edit /workspace/app/.git; that copy is never reused.
    await runtime.write(`${BUILD_GIT_ROOT}/input.json`, JSON.stringify({ action: 'check', identity: params,
      parent: parent ? { commitId: parent.commit_id } : null, worktree: '/workspace/app' }));
    const checked = await runtime.run(`${label}-reuse`, `node ${BUILD_GIT_ROOT}/git.cjs ${BUILD_GIT_ROOT}/input.json`);
    if (checked.status === 'succeeded' && JSON.parse(checked.stdout).reusable)
      return { commitId: parent?.commit_id ?? null, bundleKey: parent?.bundle_key ?? null, bundles: [], reuse: true };
  }
  const bundle = parent ? await readBundle(env, params.userId, params.appId, parent) : null;
  for (const [bundleIndex, manifest] of (bundle?.bundles ?? []).entries()) {
    for (const [index, part] of manifest.parts.entries()) {
      const object = await getStoredObject(env, params, part.key);
      if (!object || object.size !== part.size) throw new BuildError('build_git_unavailable');
      await runtime.write(`${BUILD_GIT_ROOT}/parts/${bundleIndex}-${index}`, new Uint8Array(await object.arrayBuffer()));
    }
  }
  return { ...(bundle ?? { commitId: null, bundleKey: null, bundles: [] }), reuse: false };
}
export async function hydrateBuildGit(env: Env, params: BuildParams, runtime: BuildGitRuntime, parent: BuildGitVersion | null, turn: BuildTurnRow) {
  if (!env.BUCKET) return;
  const bundle = await prepare(env, params, runtime, parent, 'git-hydrate');
  await runtime.write(`${BUILD_GIT_ROOT}/input.json`, JSON.stringify({ action: 'hydrate', parent: parent ? bundle : null,
    identity: params, date: turn.created_at, worktree: '/workspace/app' }));
  const result = await runtime.run('git-hydrate', `node ${BUILD_GIT_ROOT}/git.cjs ${BUILD_GIT_ROOT}/input.json`);
  if (result.status !== 'succeeded') throw new BuildError('build_git_unavailable', 503, result.stderr);
}
export async function saveBuildGitVersion(env: Env, params: BuildParams, runtime: BuildGitRuntime, turn: BuildTurnRow, files: BuildFiles, verified: boolean) {
  if (!env.BUCKET) throw new BuildError('build_git_unavailable');
  validateBuildFiles(files);
  const existing = await buildGitVersion(env, params.appId, params.turnId);
  if (existing) return existing;
  const app = await ownedBuildApp(env, params.userId, params.appId);
  if (!app || app.active_turn_id !== params.turnId) throw new BuildError('build_interrupted', 409);
  const parent = app.git_version_id ? await buildGitVersion(env, params.appId, app.git_version_id) : null;
  if (app.git_version_id && !parent) throw new BuildError('build_git_unavailable');
  const bundle = await prepare(env, params, runtime, parent, 'git-save', true);
  const snapshot: Record<string, string | Uint8Array<ArrayBuffer>> = { ...files, '.gitignore': BUILD_GIT_IGNORE };
  const lock = await runtime.read('/workspace/app/package-lock.json');
  if (!lock.ok && lock.status !== 404) throw new BuildError('build_git_unavailable');
  const lockfile = lock.ok ? await lock.text() : null;
  if (lockfile !== null) {
    if (new TextEncoder().encode(lockfile).length > 1024 * 1024) throw new BuildError('build_git_unavailable');
    try { JSON.parse(lockfile); } catch { throw new BuildError('build_git_unavailable'); }
    snapshot['package-lock.json'] = lockfile;
  }
  const source = Object.values(files).join('\n');
  const assets = (await savedBuildImages(env, params.appId)).filter(image => source.includes(buildImagePath(image.id)));
  for (const image of assets) snapshot[`public${buildImagePath(image.id)}`] = buildImageBytes(image.data);
  for (const [path, content] of Object.entries(snapshot)) {
    const size = typeof content === 'string' ? new TextEncoder().encode(content).length : content.byteLength;
    if (size > BUILD_GIT_MAX_FILE_BYTES) throw new BuildError('build_git_file_limit', 413, `${path} exceeds 25 MiB`);
  }
  const paths = Object.keys(snapshot).sort();
  // The snapshot path is controlled by the Worker; no untracked container files enter Git.
  const directories = [...new Set(paths.filter(path => path.includes('/')).map(path => `${BUILD_GIT_ROOT}/snapshot/${path.slice(0, path.lastIndexOf('/'))}`))];
  const setup = await runtime.run('git-snapshot-directories', `mkdir -p ${directories.join(' ') || `${BUILD_GIT_ROOT}/snapshot`}`);
  if (setup.status !== 'succeeded') throw new BuildError('build_git_unavailable');
  for (const path of paths) await runtime.write(`${BUILD_GIT_ROOT}/snapshot/${path}`, snapshot[path]);
  const message = turn.restore_version_id ? `Restore version ${turn.restore_version_id}` :
    `${verified ? 'Build' : 'Checkpoint'}: ${turn.prompt.replace(/\s+/g, ' ').trim().slice(0, 160) || 'Save app'}`;
  await runtime.write(`${BUILD_GIT_ROOT}/input.json`, JSON.stringify({ action: 'commit', parent: parent ? bundle : null,
    reuse: bundle.reuse, identity: params, paths, message,
    date: turn.created_at, force: Boolean(turn.restore_version_id), worktree: '/workspace/app' }));
  const result = await runtime.run('git-commit', `node ${BUILD_GIT_ROOT}/git.cjs ${BUILD_GIT_ROOT}/input.json`);
  if (result.status !== 'succeeded') throw new BuildError(result.stderr.includes('build_git_file_limit:') ? 'build_git_file_limit' : 'build_git_unavailable', result.stderr.includes('build_git_file_limit:') ? 413 : 503, result.stderr);
  const output = JSON.parse(result.stdout) as { commitId: string; unchanged?: boolean; size: number; parts: Omit<BuildGitPart, 'key'>[] };
  if (!gitCommitId(output.commitId) || output.unchanged && output.commitId !== parent?.commit_id) throw new BuildError('build_git_unavailable');
  const history = output.unchanged ? null : validateBuildGitBundle(params, { schemaVersion: 2, commitId: output.commitId,
    prerequisiteCommitId: parent?.commit_id ?? null, previousBundleKey: bundle.bundleKey,
    size: output.size, parts: output.parts?.map(part => ({ ...part, key: `${buildGitPrefix(params)}parts/${part.sha256}` })) });
  const bundleKey = history ? `${buildGitPrefix(params)}bundles/${output.commitId}.json` : bundle.bundleKey!;
  const manifest = await buildSourceManifest(params, files);
  const refs = [...manifest.entries, await buildObjectReference(params, manifest.bytes)];
  for (const [path, content] of Object.entries(snapshot)) if (path === 'package-lock.json' || path === '.gitignore' || content instanceof Uint8Array)
    refs.push(await buildObjectReference(params, typeof content === 'string' ? new TextEncoder().encode(content) : content));
  const objects = [...refs.map(ref => ({ key: ref.$r2, size: ref.size })), ...(history?.parts ?? [])];
  if (history) objects.push({ key: bundleKey, size: new TextEncoder().encode(JSON.stringify(history)).length });
  const fundCommit = async (writes = objects.length) => {
    try { await reserveStorageCommit(env, params, objects, writes); }
    catch (error) {
      const code = error instanceof Error ? error.message : '';
      const unfunded = ['storage_funding_required', 'insufficient_balance', 'spend_limit_exceeded'].includes(code);
      throw new BuildError(unfunded ? 'storage_funding_required' : 'build_billing_unavailable', unfunded ? 402 : 503);
    }
  };
  await runtime.persist('Persist Git bundle', async () => {
    // A Workflow step retries this callback, not the surrounding function. D1
    // may have committed before its response was lost, so reconcile on every attempt.
    if (await buildGitVersion(env, params.appId, params.turnId)) return;
    await fundCommit();
    const source = await storeBuildSource(env, params, files);
    const storedLockfile = lockfile === null ? null : await storeBuildText(env, params, lockfile, 'source');
    for (const [path, content] of Object.entries(snapshot)) if (path === '.gitignore' || content instanceof Uint8Array)
      await storeBuildObject(env, params, typeof content === 'string' ? new TextEncoder().encode(content) : content, path === '.gitignore' ? 'text/plain; charset=utf-8' : 'image/jpeg');
    for (const [index, part] of (history?.parts ?? []).entries()) {
      const response = await runtime.read(`${BUILD_GIT_ROOT}/output/${index}`);
      if (!response.ok) throw new BuildError('build_git_unavailable');
      const bytes = await response.arrayBuffer();
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
      if (bytes.byteLength !== part.size || hash !== part.sha256) throw new BuildError('build_git_unavailable');
      await putStoredObject(env, params, part.key, bytes, 'history', { onlyIf: { etagDoesNotMatch: '*' }, sha256: hash });
    }
    if (history) await putStoredObject(env, params, bundleKey, JSON.stringify(history), 'history',
      { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' } });
    // Refresh the complete hold after per-object reservations and before accepting
    // the head; other account usage may have consumed funds during the uploads.
    await fundCommit(0);
    // Publish the database head only after all immutable R2 objects exist.
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO build_git_versions (id, app_id, parent_version_id, commit_id, bundle_key, source_json, lockfile, assets_json, message, verified, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(params.turnId, params.appId, app.git_version_id ?? null, output.commitId, bundleKey,
        source, storedLockfile, JSON.stringify(assets.map(image => image.id)), message, verified ? 1 : 0, turn.created_at),
      env.DB.prepare('UPDATE build_apps SET git_version_id = ? WHERE id = ? AND user_id = ? AND active_turn_id = ? AND git_version_id IS ?')
        .bind(params.turnId, params.appId, params.userId, params.turnId, app.git_version_id ?? null),
    ]);
  }).catch(error => {
    if (error instanceof Error && ['storage_funding_required', 'insufficient_balance', 'spend_limit_exceeded'].includes(error.message))
      throw new BuildError('storage_funding_required', 402);
    throw error;
  });
  await runtime.write(`${BUILD_GIT_ROOT}/input.json`, JSON.stringify({ action: 'publish', identity: params,
    parent: { commitId: output.commitId }, worktree: '/workspace/app' }));
  const published = await runtime.run('git-publish', `node ${BUILD_GIT_ROOT}/git.cjs ${BUILD_GIT_ROOT}/input.json`);
  if (published.status !== 'succeeded') throw new BuildError('build_git_unavailable', 503, published.stderr);
  return (await buildGitVersion(env, params.appId, params.turnId))!;
}
export async function buildGitEntries(env: Env, owner: BuildStorageOwner, version: BuildGitVersion): Promise<BuildStoredFile[]> {
  const entries = await buildSourceEntries(env, owner, version.source_json);
  const ignore = await buildTextEntry(owner, '.gitignore', BUILD_GIT_IGNORE);
  // New snapshots persist this platform-authored file as an R2 object too.
  if (buildObjectRef(JSON.parse(version.source_json))) delete ignore.inline;
  entries.push(ignore);
  if (version.lockfile !== null) entries.push(await buildTextEntry(owner, 'package-lock.json', version.lockfile));
  const images = await buildImageEntries(env, owner, JSON.parse(version.assets_json));
  return [...entries.filter(entry => !images.some(image => image.path === entry.path)), ...images].sort((a, b) => a.path.localeCompare(b.path));
}
export async function exportBuildGit(env: Env, userId: string, appId: string, version: BuildGitVersion, headers: HeadersInit) {
  const bundle = await readBundle(env, userId, appId, version);
  return exportBuildGitBundles(env, { userId, appId }, bundle.bundles, bundle.commitId, headers);
}
export async function deleteBuildGit(env: Env, userId: string, appId: string) {
  if (!env.BUCKET) return;
  const taskPrefix = buildGitPrefix({ userId, appId });
  const token = storageMetered(env) ? await acquireStorageLock(env, appId) : null;
  try {
  // Delete and list from the beginning again so deletion does not invalidate a cursor.
  for (;;) {
    const objects = await listStoredObjects(env, { userId, appId }, { prefix: taskPrefix, limit: 1000 });
    if (!objects.objects.length) return;
    await deleteStoredObjects(env, { userId, appId }, objects.objects.map(object => object.key));
  }
  } finally { if (token) await releaseStorageLock(env, appId, token); }
}
export async function cleanupDeletedBuildGit(env: Env) {
  if (!env.BUCKET) return;
  const cursor = await env.DB.prepare("SELECT value FROM r2_meter_state WHERE id='deletion_cursor'").first<{ value: string }>();
  const { results } = await env.DB.prepare('SELECT * FROM build_git_deletions WHERE app_id>? ORDER BY app_id LIMIT 20').bind(cursor?.value ?? '').all<{ app_id: string; user_id: string }>();
  for (const task of results) {
    try {
      await deleteBuildGit(env, task.user_id, task.app_id);
      await env.DB.prepare('DELETE FROM build_git_deletions WHERE app_id = ?').bind(task.app_id).run();
    } catch { console.error('build_git_deletion_deferred', { appId: task.app_id }); }
  }
  await env.DB.prepare("INSERT INTO r2_meter_state(id,value) VALUES('deletion_cursor',?) ON CONFLICT(id) DO UPDATE SET value=excluded.value")
    .bind(results.length === 20 ? results.at(-1)!.app_id : '').run();
}

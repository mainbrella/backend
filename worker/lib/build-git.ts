import { BuildError, ownedBuildApp, validateBuildFiles, type BuildFiles, type BuildParams, type BuildTurnRow } from './build-contract';
import { buildImageBytes, buildImagePath, savedBuildImages, buildImageEntries } from './build-images';
import { buildGitProgram } from './build-git-program';
import { storeBuildSource, storeBuildText, storeBuildObject, buildSourceEntries, buildTextEntry, buildObjectRef, type BuildStorageOwner, type BuildStoredFile } from './build-storage';

export const BUILD_GIT_ROOT = '/workspace/mainbrella-git';
export const BUILD_GIT_IGNORE = 'node_modules/\ndist/\n.env\n.env.*\n';
export type BuildGitVersion = {
  id: string; app_id: string; parent_version_id: string | null; commit_id: string; bundle_key: string;
  source_json: string; lockfile: string | null; assets_json: string; message: string; verified: number; created_at: string;
};
type Part = { key: string; size: number; sha256: string };
type Bundle = { schemaVersion: 1; commitId: string; size: number; parts: Part[] };
export type BuildGitRuntime = {
  run(label: string, command: string): Promise<{ status: string; stdout: string; stderr: string }>;
  write(path: string, content: string | Uint8Array<ArrayBuffer>): Promise<void>;
  read(path: string): Promise<Response>;
  persist(label: string, action: () => Promise<void>): Promise<void>;
};
const prefix = (userId: string, appId: string) => `build-git/${userId}/${appId}/`;
export const buildGitVersion = (env: Env, appId: string, id: string) => env.DB.prepare('SELECT * FROM build_git_versions WHERE app_id = ? AND id = ?').bind(appId, id).first<BuildGitVersion>();
export const publicGitVersion = (version: BuildGitVersion) => ({ id: version.id, commitId: version.commit_id,
  parentVersionId: version.parent_version_id, message: version.message, verified: Boolean(version.verified), createdAt: version.created_at });

async function readBundle(env: Env, userId: string, appId: string, version: BuildGitVersion): Promise<Bundle> {
  if (!env.BUCKET || !version.bundle_key.startsWith(prefix(userId, appId))) throw new BuildError('build_git_unavailable');
  const object = await env.BUCKET.get(version.bundle_key);
  if (!object) throw new BuildError('build_git_unavailable');
  const bundle = await object.json<Bundle>();
  if (bundle.schemaVersion !== 1 || bundle.commitId !== version.commit_id || !/^[a-f0-9]{40}$/.test(bundle.commitId)
    || !Number.isSafeInteger(bundle.size) || bundle.size < 1 || bundle.size > 128 * 1024 * 1024
    || !Array.isArray(bundle.parts) || !bundle.parts.length || bundle.parts.length > 128
    || bundle.parts.some(part => !part.key.startsWith(prefix(userId, appId)) || !/^[a-f0-9]{64}$/.test(part.sha256)
      || !Number.isSafeInteger(part.size) || part.size < 1 || part.size > 1024 * 1024)
    || bundle.parts.reduce((total, part) => total + part.size, 0) !== bundle.size) throw new BuildError('build_git_unavailable');
  return bundle;
}
async function prepare(env: Env, params: BuildParams, runtime: BuildGitRuntime, parent: BuildGitVersion | null, label: string) {
  const result = await runtime.run(`${label}-directories`, `mkdir -p ${BUILD_GIT_ROOT}/parts ${BUILD_GIT_ROOT}/snapshot /workspace/app`);
  if (result.status !== 'succeeded') throw new BuildError('build_git_unavailable');
  await runtime.write(`${BUILD_GIT_ROOT}/git.cjs`, buildGitProgram);
  const bundle = parent ? await readBundle(env, params.userId, params.appId, parent) : null;
  for (const [index, part] of (bundle?.parts ?? []).entries()) {
    const object = await env.BUCKET!.get(part.key);
    if (!object || object.size !== part.size) throw new BuildError('build_git_unavailable');
    await runtime.write(`${BUILD_GIT_ROOT}/parts/${index}`, new Uint8Array(await object.arrayBuffer()));
  }
  return bundle;
}
export async function hydrateBuildGit(env: Env, params: BuildParams, runtime: BuildGitRuntime, parent: BuildGitVersion | null, turn: BuildTurnRow) {
  if (!env.BUCKET) return;
  const bundle = await prepare(env, params, runtime, parent, 'git-hydrate');
  await runtime.write(`${BUILD_GIT_ROOT}/input.json`, JSON.stringify({ action: 'hydrate', parent: bundle, date: turn.created_at, worktree: '/workspace/app' }));
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
  const bundle = await prepare(env, params, runtime, parent, 'git-save');
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
  const paths = Object.keys(snapshot).sort();
  // The snapshot path is controlled by the Worker; no untracked container files enter Git.
  const directories = [...new Set(paths.filter(path => path.includes('/')).map(path => `${BUILD_GIT_ROOT}/snapshot/${path.slice(0, path.lastIndexOf('/'))}`))];
  const setup = await runtime.run('git-snapshot-directories', `mkdir -p ${directories.join(' ') || `${BUILD_GIT_ROOT}/snapshot`}`);
  if (setup.status !== 'succeeded') throw new BuildError('build_git_unavailable');
  for (const path of paths) await runtime.write(`${BUILD_GIT_ROOT}/snapshot/${path}`, snapshot[path]);
  const message = turn.restore_version_id ? `Restore version ${turn.restore_version_id}` :
    `${verified ? 'Build' : 'Checkpoint'}: ${turn.prompt.replace(/\s+/g, ' ').trim().slice(0, 160) || 'Save app'}`;
  await runtime.write(`${BUILD_GIT_ROOT}/input.json`, JSON.stringify({ action: 'commit', parent: bundle, paths, message,
    date: turn.created_at, force: Boolean(turn.restore_version_id), worktree: '/workspace/app' }));
  const result = await runtime.run('git-commit', `node ${BUILD_GIT_ROOT}/git.cjs ${BUILD_GIT_ROOT}/input.json`);
  if (result.status !== 'succeeded') throw new BuildError('build_git_unavailable', 503, result.stderr);
  const output = JSON.parse(result.stdout) as Omit<Bundle, 'schemaVersion' | 'parts'> & { parts: Omit<Part, 'key'>[] };
  if (!/^[a-f0-9]{40}$/.test(output.commitId) || !output.parts.length || output.parts.length > 128) throw new BuildError('build_git_unavailable');
  await runtime.persist('Persist Git bundle', async () => {
    // A Workflow step retries this callback, not the surrounding function. D1
    // may have committed before its response was lost, so reconcile on every attempt.
    if (await buildGitVersion(env, params.appId, params.turnId)) return;
    const source = await storeBuildSource(env, params, files);
    const storedLockfile = lockfile === null ? null : await storeBuildText(env, params, lockfile);
    for (const [path, content] of Object.entries(snapshot)) if (path === '.gitignore' || content instanceof Uint8Array)
      await storeBuildObject(env, params, typeof content === 'string' ? new TextEncoder().encode(content) : content, path === '.gitignore' ? 'text/plain; charset=utf-8' : 'image/jpeg');
    const parts: Part[] = [];
    for (const [index, part] of output.parts.entries()) {
      const response = await runtime.read(`${BUILD_GIT_ROOT}/output/${index}`);
      if (!response.ok) throw new BuildError('build_git_unavailable');
      const bytes = await response.arrayBuffer();
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
      if (bytes.byteLength !== part.size || hash !== part.sha256) throw new BuildError('build_git_unavailable');
      const key = `${prefix(params.userId, params.appId)}parts/${hash}`;
      await env.BUCKET!.put(key, bytes, { onlyIf: { etagDoesNotMatch: '*' }, sha256: hash });
      parts.push({ ...part, key });
    }
    const bundleKey = `${prefix(params.userId, params.appId)}bundles/${output.commitId}.json`;
    await env.BUCKET!.put(bundleKey, JSON.stringify({ schemaVersion: 1, commitId: output.commitId, size: output.size, parts } satisfies Bundle),
      { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' } });
    // Publish the database head only after all immutable R2 objects exist.
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO build_git_versions (id, app_id, parent_version_id, commit_id, bundle_key, source_json, lockfile, assets_json, message, verified, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(params.turnId, params.appId, app.git_version_id ?? null, output.commitId, bundleKey,
        source, storedLockfile, JSON.stringify(assets.map(image => image.id)), message, verified ? 1 : 0, turn.created_at),
      env.DB.prepare('UPDATE build_apps SET git_version_id = ? WHERE id = ? AND user_id = ? AND active_turn_id = ? AND git_version_id IS ?')
        .bind(params.turnId, params.appId, params.userId, params.turnId, app.git_version_id ?? null),
    ]);
  });
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
  let index = 0;
  const body = new ReadableStream<Uint8Array>({ async pull(controller) {
    if (index === bundle.parts.length) { controller.close(); return; }
    const part = bundle.parts[index++], object = await env.BUCKET!.get(part.key);
    if (!object || object.size !== part.size) { controller.error(new Error('Repository unavailable')); return; }
    controller.enqueue(new Uint8Array(await object.arrayBuffer()));
  } });
  return new Response(body, { headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(bundle.size),
    'Content-Disposition': 'attachment; filename="mainbrella-app.bundle"', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
}
export async function deleteBuildGit(env: Env, userId: string, appId: string) {
  if (!env.BUCKET) return;
  const taskPrefix = prefix(userId, appId);
  // Delete and list from the beginning again so deletion does not invalidate a cursor.
  for (;;) {
    const objects = await env.BUCKET.list({ prefix: taskPrefix, limit: 1000 });
    if (!objects.objects.length) return;
    await env.BUCKET.delete(objects.objects.map(object => object.key));
  }
}
export async function cleanupDeletedBuildGit(env: Env) {
  if (!env.BUCKET) return;
  const { results } = await env.DB.prepare('SELECT * FROM build_git_deletions ORDER BY created_at LIMIT 20').all<{ app_id: string; user_id: string }>();
  for (const task of results) {
    try {
      await deleteBuildGit(env, task.user_id, task.app_id);
      await env.DB.prepare('DELETE FROM build_git_deletions WHERE app_id = ?').bind(task.app_id).run();
    } catch { console.error('build_git_deletion_deferred', { appId: task.app_id }); }
  }
}

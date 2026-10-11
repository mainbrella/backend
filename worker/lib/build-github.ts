import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { BUILD_MAX_FILES, BUILD_MAX_FILE_BYTES, BUILD_MAX_SOURCE_BYTES, BuildError, validBuildPath, validateBuildFiles, type BuildFiles, type BuildParams, type BuildTurnRow } from './build-contract';
import { githubBuildAPI, githubBuildUserToken, validGithubBranch } from './github-build';
import { repoName } from './repo-launch';
import { downloadGitPack } from './github-import';
import { buildGitVersion, buildGitEntries, exportBuildGit, BUILD_GIT_IGNORE, type BuildGitRuntime, type BuildGitVersion } from './build-git';
import { buildImageBytes, buildImagePath, savedBuildImages } from './build-images';
import { readBuildSource, readBuildText, storeBuildSource } from './build-storage';
import { acquireStorageLock, releaseStorageLock, storageMetered, listStoredObjects, deleteStoredObjects } from './r2-storage';

export interface GithubProject {
  id: string; user_id: string; github_repo: string | null; github_branch: string | null; github_commit_id: string | null;
  github_paths_json: string; github_link_lock: string | null; github_link_until: number; github_cleanup_pending: number;
}
type TreeEntry = { path: string; mode: string; type: string; sha: string; size?: number };
const encoder = new TextEncoder(), decoder = new TextDecoder();
const commitId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
export const githubProject = (env: Env, userId: string, appId: string) => env.DB.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?')
  .bind(appId, userId).first<GithubProject>();
export const publicGithubProject = (project: GithubProject) => project.github_repo ? {
  repo: project.github_repo, branch: project.github_branch!, commitId: project.github_commit_id,
  url: `https://github.com/${project.github_repo}/tree/${encodeURIComponent(project.github_branch!)}`,
} : null;
const refPath = (branch: string) => branch.split('/').map(encodeURIComponent).join('/');
function assertRepository(repo: string, branch: string) {
  if (!repoName.safeParse(repo).success || !validGithubBranch(branch)) throw new BuildError('invalid_request', 400);
}
function upstreamError(response: Response): never {
  if (response.status === 401) throw new BuildError('github_connection_required', 400);
  if (response.status === 429 || response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') throw new BuildError('github_rate_limited', 429);
  if ([403, 404].includes(response.status)) throw new BuildError('github_write_access_required', 403);
  throw new BuildError('github_unavailable');
}
async function rawGithub(url: string, token: string, options: RequestInit = {}) {
  try {
    return await fetch(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(60_000),
      headers: { Authorization: url.startsWith('https://github.com/') ? `Basic ${btoa(`x-access-token:${token}`)}` : `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Mainbrella-Build',
        'X-GitHub-Api-Version': '2026-03-10', ...options.headers } });
  } catch { throw new BuildError('github_unavailable'); }
}
export async function githubHead(repo: string, branch: string, token: string): Promise<string | null> {
  assertRepository(repo, branch);
  const response = await rawGithub(`https://api.github.com/repos/${repo}/git/ref/heads/${refPath(branch)}`, token);
  if ([404, 409].includes(response.status)) return null;
  if (!response.ok) upstreamError(response);
  const data = await response.json() as { object?: { sha: string } };
  if (!commitId(data.object?.sha)) throw new BuildError('github_unavailable');
  return data.object.sha;
}
export async function checkGithubWriteAccess(repo: string, token: string) {
  const data = await githubBuildAPI(`/repos/${repo}`, token);
  if (data.full_name?.toLowerCase() !== repo.toLowerCase() || data.permissions?.push !== true) throw new BuildError('github_write_access_required', 403);
  // Repository permissions describe the user. Receive-pack also checks the
  // app's Contents write grant, including installations awaiting approval.
  const access = await rawGithub(`https://github.com/${repo}.git/info/refs?service=git-receive-pack`, token);
  await access.body?.cancel();
  if (!access.ok) upstreamError(access);
}
function packets(bytes: Uint8Array): string[] {
  const lines: string[] = [];
  for (let offset = 0; offset < bytes.length;) {
    const header = decoder.decode(bytes.subarray(offset, offset + 4));
    if (!/^[0-9a-f]{4}$/.test(header)) throw new BuildError('github_unavailable');
    const size = parseInt(header, 16);
    offset += 4;
    if (!size) continue;
    if (size < 4 || offset + size - 4 > bytes.length) throw new BuildError('github_unavailable');
    lines.push(decoder.decode(bytes.subarray(offset, offset + size - 4))); offset += size - 4;
  }
  return lines;
}
const packet = (value: string) => encoder.encode((encoder.encode(value).length + 4).toString(16).padStart(4, '0') + value);
// Transfer the original pack, including every saved ancestor, without starting a
// container or handing GitHub credentials to application code.
export async function pushGithubHistory(repo: string, branch: string, sha: string, bundle: Response, token: string) {
  assertRepository(repo, branch);
  const base = `https://github.com/${repo}.git`;
  const advertised = await rawGithub(`${base}/info/refs?service=git-receive-pack`, token);
  if (!advertised.ok) upstreamError(advertised);
  if (Number(advertised.headers.get('content-length')) > 1024 * 1024) throw new BuildError('github_unavailable');
  const advertisedBytes = new Uint8Array(await advertised.arrayBuffer());
  if (advertisedBytes.length > 1024 * 1024) throw new BuildError('github_unavailable');
  const refs = packets(advertisedBytes);
  const destination = `refs/heads/${branch}`;
  const advertisedHead = refs.find(line => line.slice(41).split(/[\0\n]/)[0] === destination)?.slice(0, 40);
  const current = advertisedHead === '0'.repeat(40) ? undefined : advertisedHead;
  if (current === sha) { await bundle.body?.cancel(); return; }
  if (current) { await bundle.body?.cancel(); throw new BuildError('github_branch_conflict', 409); }
  const reader = bundle.body?.getReader();
  if (!reader) throw new BuildError('build_git_unavailable');
  let header = new Uint8Array(), headerDone = false;
  const prefix = packet(`${'0'.repeat(40)} ${sha} ${destination}\0report-status\n`);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(prefix); controller.enqueue(encoder.encode('0000')); },
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) { if (!headerDone) throw new Error('Invalid bundle'); controller.close(); return; }
        if (headerDone) { controller.enqueue(next.value); return; }
        const joined = new Uint8Array(header.length + next.value.length); joined.set(header); joined.set(next.value, header.length);
        for (let index = 0; index + 1 < joined.length; index++) if (joined[index] === 10 && joined[index + 1] === 10) {
          if (decoder.decode(joined.subarray(0, index)) !== `# v2 git bundle\n${sha} refs/heads/main`) throw new Error('Invalid bundle');
          headerDone = true; controller.enqueue(joined.subarray(index + 2)); return;
        }
        if (joined.length > 4096) throw new Error('Invalid bundle');
        header = joined;
      } catch { controller.error(new Error('Repository transfer failed')); await reader.cancel().catch(() => {}); }
    },
    cancel() { return reader.cancel(); },
  });
  const response = await rawGithub(`${base}/git-receive-pack`, token, { method: 'POST', body: stream,
    headers: { 'Content-Type': 'application/x-git-receive-pack-request', Accept: 'application/x-git-receive-pack-result' } });
  if (!response.ok) upstreamError(response);
  const result = packets(new Uint8Array(await response.arrayBuffer()));
  if (!result.includes('unpack ok\n') || !result.includes(`ok ${destination}\n`))
    throw new BuildError(result.some(line => /protected|hook declined|rules/.test(line)) ? 'github_branch_protected' : 'github_branch_conflict', 409);
  if (await githubHead(repo, branch, token) !== sha) throw new BuildError('github_branch_conflict', 409);
}
export async function githubTree(repo: string, sha: string, token: string): Promise<TreeEntry[]> {
  const result = await githubBuildAPI(`/repos/${repo}/git/trees/${sha}?recursive=1`, token);
  if (result.truncated || !Array.isArray(result.tree) || result.tree.length > 10_000) throw new BuildError('github_source_limit', 413);
  return result.tree;
}
async function blobBytes(repo: string, entry: TreeEntry, token: string) {
  if ((entry.size ?? 0) > 26_214_400) throw new BuildError('build_git_file_limit', 413);
  const blob = await githubBuildAPI(`/repos/${repo}/git/blobs/${entry.sha}`, token);
  if (blob.encoding !== 'base64' || typeof blob.content !== 'string') throw new BuildError('github_unavailable');
  const binary = atob(blob.content.replace(/\s/g, ''));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}
export async function githubSource(repo: string, sha: string, token: string): Promise<BuildFiles> {
  const files: BuildFiles = {};
  const entries = (await githubTree(repo, sha, token)).filter(entry => entry.type === 'blob' && entry.mode === '100644' && validBuildPath(entry.path)
    && !/\.(png|jpe?g|gif|webp|ico|woff2?|pdf|zip|mp4|mp3)$/i.test(entry.path));
  if (entries.length > BUILD_MAX_FILES || entries.some(entry => (entry.size ?? 0) > BUILD_MAX_FILE_BYTES)
    || entries.reduce((size, entry) => size + (entry.size ?? 0), 0) > BUILD_MAX_SOURCE_BYTES) throw new BuildError('github_source_limit', 413);
  let sourceBytes = 2;
  for (let offset = 0; offset < entries.length; offset += 8) {
    const batch = entries.slice(offset, offset + 8);
    const blobs = await Promise.all(batch.map(entry => blobBytes(repo, entry, token)));
    for (const [index, entry] of batch.entries()) {
      const bytes = blobs[index];
      if (bytes.length > BUILD_MAX_FILE_BYTES) throw new BuildError('github_source_limit', 413);
      try { files[entry.path] = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new BuildError('github_source_limit', 413); }
      // Account for JSON escaping as each batch arrives, rather than buffering
      // an oversized repository before validating the complete source map.
      sourceBytes += encoder.encode(JSON.stringify(entry.path)).length + encoder.encode(JSON.stringify(files[entry.path])).length + 2;
      if (sourceBytes - 1 > BUILD_MAX_SOURCE_BYTES) throw new BuildError('github_source_limit', 413);
    }
  }
  try { validateBuildFiles(files); } catch { throw new BuildError('github_source_limit', 413); }
  return files;
}
export async function githubSnapshot(env: Env, params: { userId: string; appId: string }, files: BuildFiles, lockfile?: string | null) {
  const snapshot: Record<string, Uint8Array> = Object.fromEntries(Object.entries(files).map(([path, content]) => [path, encoder.encode(content)]));
  snapshot['.gitignore'] = encoder.encode(BUILD_GIT_IGNORE);
  if (lockfile) snapshot['package-lock.json'] = encoder.encode(lockfile);
  const source = Object.values(files).join('\n');
  for (const image of await savedBuildImages(env, params.appId)) if (source.includes(buildImagePath(image.id)))
    snapshot[`public${buildImagePath(image.id)}`] = buildImageBytes(image.data);
  return snapshot;
}
function gitBlobSha(bytes: Uint8Array) { return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'); }
function base64(bytes: Uint8Array) {
  let text = ''; for (let offset = 0; offset < bytes.length; offset += 8192) text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(text);
}
export async function commitGithubSnapshot(repo: string, branch: string, parent: string | null, paths: string[], snapshot: Record<string, Uint8Array>, message: string, date: string, token: string) {
  assertRepository(repo, branch);
  if (await githubHead(repo, branch, token) !== parent) throw new BuildError('github_branch_conflict', 409);
  if (!parent) {
    const initial = rootSnapshotBundle(snapshot, message, date);
    await pushGithubHistory(repo, branch, initial.sha, new Response(initial.bundle), token);
    return initial.sha;
  }
  const old = parent ? new Map((await githubTree(repo, parent, token)).map(entry => [entry.path, entry])) : new Map<string, TreeEntry>();
  const tree: { path: string; mode: string; type: string; sha: string | null }[] = [];
  for (const [path, bytes] of Object.entries(snapshot).sort(([a], [b]) => a.localeCompare(b))) {
    if (bytes.length > 26_214_400) throw new BuildError('build_git_file_limit', 413);
    // GitHub users may extend their ignore rules. Keep an existing file rather
    // than replacing it with Builder's starter rules on every commit.
    if (path === '.gitignore' && old.has(path)) continue;
    const sha = gitBlobSha(bytes);
    if (old.get(path)?.sha === sha && old.get(path)?.mode === '100644') continue;
    const blob = await githubBuildAPI(`/repos/${repo}/git/blobs`, token, 'POST', { content: base64(bytes), encoding: 'base64' });
    if (blob.sha !== sha) throw new BuildError('github_unavailable');
    tree.push({ path, mode: '100644', type: 'blob', sha });
  }
  for (const path of paths) if (!(path in snapshot) && old.has(path)) tree.push({ path, mode: '100644', type: 'blob', sha: null });
  if (!tree.length && parent) return parent;
  const parentCommit = parent ? await githubBuildAPI(`/repos/${repo}/git/commits/${parent}`, token) : null;
  const nextTree = await githubBuildAPI(`/repos/${repo}/git/trees`, token, 'POST', { ...(parentCommit ? { base_tree: parentCommit.tree.sha } : {}), tree });
  const commit = await githubBuildAPI(`/repos/${repo}/git/commits`, token, 'POST', { message, tree: nextTree.sha, parents: parent ? [parent] : [],
    author: { name: 'Mainbrella', email: 'build@mainbrella.invalid', date }, committer: { name: 'Mainbrella', email: 'build@mainbrella.invalid', date } });
  if (!commitId(commit.sha)) throw new BuildError('github_unavailable');
  // A lost write response is reconciled from the head. Never force a branch.
  try {
    await githubBuildAPI(`/repos/${repo}/git/refs/heads/${refPath(branch)}`, token, 'PATCH', { sha: commit.sha, force: false });
  } catch (error) { if (await githubHead(repo, branch, token) !== commit.sha) throw error; }
  if (await githubHead(repo, branch, token) !== commit.sha) throw new BuildError('github_branch_conflict', 409);
  return commit.sha;
}
// A small self-contained root pack handles genuinely empty GitHub repositories;
// their Git database REST endpoints cannot create the initial branch.
export function rootSnapshotBundle(snapshot: Record<string, Uint8Array>, message: string, date: string) {
  const objects: { type: number; data: Uint8Array; sha: string }[] = [];
  const object = (name: string, type: number, data: Uint8Array) => {
    const sha = createHash('sha1').update(`${name} ${data.length}\0`).update(data).digest('hex');
    objects.push({ type, data, sha }); return sha;
  };
  const tree = (prefix: string): string => {
    const entries = new Map<string, { mode: string; sha: string }>();
    for (const [path, bytes] of Object.entries(snapshot)) if (path.startsWith(prefix)) {
      const relative = path.slice(prefix.length), slash = relative.indexOf('/');
      if (slash < 0) entries.set(relative, { mode: '100644', sha: object('blob', 3, bytes) });
      else { const folder = relative.slice(0, slash); if (!entries.has(folder)) entries.set(folder, { mode: '40000', sha: tree(`${prefix}${folder}/`) }); }
    }
    const data = Buffer.concat([...entries].sort(([a, x], [b, y]) => Buffer.compare(Buffer.from(a + (x.mode === '40000' ? '/' : '')), Buffer.from(b + (y.mode === '40000' ? '/' : ''))))
      .map(([name, entry]) => Buffer.concat([Buffer.from(`${entry.mode} ${name}\0`), Buffer.from(entry.sha, 'hex')])));
    return object('tree', 2, data);
  };
  const treeSha = tree(''), stamp = `${Math.floor(Date.parse(date) / 1000)} +0000`;
  const sha = object('commit', 1, encoder.encode(`tree ${treeSha}\nauthor Mainbrella <build@mainbrella.invalid> ${stamp}\ncommitter Mainbrella <build@mainbrella.invalid> ${stamp}\n\n${message}\n`));
  const packHeader = Buffer.alloc(12); packHeader.write('PACK'); packHeader.writeUInt32BE(2, 4); packHeader.writeUInt32BE(objects.length, 8);
  const packed = objects.map(({ type, data }) => {
    let size = data.length, byte = type << 4 | size & 15; size = Math.floor(size / 16);
    const header: number[] = [];
    while (size) { header.push(byte | 128); byte = size & 127; size = Math.floor(size / 128); }
    header.push(byte);
    return Buffer.concat([Buffer.from(header), deflateSync(data)]);
  });
  const pack = Buffer.concat([packHeader, ...packed]);
  return { sha, bundle: Buffer.concat([Buffer.from(`# v2 git bundle\n${sha} refs/heads/main\n\n`), pack, createHash('sha1').update(pack).digest()]) };
}
export async function saveGithubVersion(env: Env, params: BuildParams, runtime: BuildGitRuntime, turn: BuildTurnRow, files: BuildFiles, verified: boolean): Promise<BuildGitVersion> {
  validateBuildFiles(files);
  const message = `${turn.restore_version_id ? 'Restore' : verified ? 'Build' : 'Checkpoint'}: ${turn.prompt.replace(/\s+/g, ' ').trim().slice(0, 160) || 'Save app'}\n\nMainbrella-Turn: ${params.turnId}`;
  await runtime.persist('Commit directly to GitHub', async () => {
    const project = await githubProject(env, params.userId, params.appId);
    if (!project?.github_repo || !project.github_branch) throw new BuildError('github_connection_required', 400);
    const app = await env.DB.prepare('SELECT active_turn_id FROM build_apps WHERE id=? AND user_id=?').bind(params.appId, params.userId).first<{ active_turn_id: string | null }>();
    if (app?.active_turn_id !== params.turnId) throw new BuildError('build_interrupted', 409);
    const token = await githubBuildUserToken(env, params.userId);
    const lock = await runtime.read('/workspace/app/package-lock.json');
    if (!lock.ok && lock.status !== 404) throw new BuildError('github_unavailable');
    const lockfile = lock.ok ? await lock.text() : null;
    if (lockfile) {
      if (encoder.encode(lockfile).length > 1024 * 1024) throw new BuildError('github_source_limit', 413);
      try { JSON.parse(lockfile); } catch { throw new BuildError('github_source_limit', 413); }
    }
    const snapshot = await githubSnapshot(env, params, files, lockfile);
    // A checkout may contain externally edited or restored generated assets.
    // Commit those bytes, rather than replacing them with an older R2 original.
    for (const path of Object.keys(snapshot)) if (path.startsWith('public/generated/')) {
      const asset = await runtime.read(`/workspace/app/${path}`);
      if (asset.ok) snapshot[path] = new Uint8Array(await asset.arrayBuffer());
      else if (asset.status !== 404) throw new BuildError('github_unavailable');
    }
    const remote = await githubHead(project.github_repo, project.github_branch, token);
    let sha: string;
    if (remote !== project.github_commit_id && remote) {
      const existing = await githubBuildAPI(`/repos/${project.github_repo}/git/commits/${remote}`, token);
      // Reconcile a GitHub commit accepted before its D1 pointer was saved.
      if (existing.message !== message || existing.parents?.[0]?.sha !== project.github_commit_id) throw new BuildError('github_branch_conflict', 409);
      sha = remote;
    } else sha = await commitGithubSnapshot(project.github_repo, project.github_branch, project.github_commit_id,
      JSON.parse(project.github_paths_json), snapshot, message, turn.created_at, token);
    const updated = await env.DB.prepare(`UPDATE projects SET github_commit_id=?,github_paths_json=? WHERE id=? AND user_id=? AND github_repo=? AND github_commit_id IS ?
      AND EXISTS(SELECT 1 FROM build_apps WHERE id=? AND active_turn_id=?)`)
      .bind(sha, JSON.stringify(Object.keys(snapshot)), project.id, params.userId, project.github_repo, project.github_commit_id, params.appId, params.turnId).run();
    if (!updated.meta.changes) throw new BuildError('build_interrupted', 409);
    if (verified) await env.DB.prepare('UPDATE build_apps SET github_verified_commit_id=? WHERE id=? AND active_turn_id=?').bind(sha, params.appId, params.turnId).run();
  });
  // Workflow steps may reuse cached results without running the callback.
  const project = await githubProject(env, params.userId, params.appId);
  if (!project?.github_commit_id) throw new BuildError('github_unavailable');
  return { id: project.github_commit_id, app_id: params.appId, commit_id: project.github_commit_id, parent_version_id: null, bundle_key: '',
    source_json: JSON.stringify(files), lockfile: null, assets_json: '[]', message, verified: verified ? 1 : 0, created_at: turn.created_at };
}
export async function migrateGithubProject(env: Env, project: GithubProject, app: { id: string; source_json: string; git_version_id?: string | null }, repo: string, branch: string, token: string) {
  const parent = app.git_version_id ? await buildGitVersion(env, app.id, app.git_version_id) : null;
  if (app.git_version_id && !parent) throw new BuildError('build_git_unavailable');
  const head = await githubHead(repo, branch, token);
  if (parent) {
    if (!head) await pushGithubHistory(repo, branch, parent.commit_id, await exportBuildGit(env, project.user_id, app.id, parent, {}), token);
  }
  const files = await readBuildSource(env, { userId: project.user_id, appId: app.id }, app.source_json);
  const lockfile = parent?.lockfile ? await readBuildText(env, { userId: project.user_id, appId: app.id }, parent.lockfile) : null;
  if (!Object.keys(files).length && !parent) {
    if (!head) return { sha: null, paths: [] as string[], files };
    const imported = await githubSource(repo, head, token);
    return { sha: head, paths: Object.keys(imported), files: imported };
  }
  const snapshot = await githubSnapshot(env, { userId: project.user_id, appId: app.id }, files, lockfile);
  const message = `Connect project to Mainbrella Build\n\nMainbrella-Project: ${project.id}`;
  const paths = parent ? (await buildGitEntries(env, { userId: project.user_id, appId: app.id }, parent)).map(entry => entry.path) : [];
  if (parent && head && head !== parent.commit_id) {
    // The last transfer request may have committed a draft before its D1
    // acknowledgement was lost. Only accept that exact project snapshot.
    const commit = await githubBuildAPI(`/repos/${repo}/git/commits/${head}`, token);
    const tree = new Map((await githubTree(repo, head, token)).map(entry => [entry.path, entry]));
    if (commit.message !== message || commit.parents?.[0]?.sha !== parent.commit_id
      || Object.entries(snapshot).some(([path, bytes]) => tree.get(path)?.sha !== gitBlobSha(bytes))
      || paths.some(path => !(path in snapshot) && tree.has(path))) throw new BuildError('github_branch_conflict', 409);
    return { sha: head, paths: Object.keys(snapshot), files };
  }
  // Include draft edits saved after the last successful checkpoint.
  const sha = await commitGithubSnapshot(repo, branch, parent?.commit_id ?? head, paths, snapshot,
    message, new Date().toISOString(), token);
  return { sha, paths: Object.keys(snapshot), files };
}
export async function cleanupGithubHostedHistory(env: Env, project: GithubProject) {
  if (!project.github_repo || !project.github_cleanup_pending || !env.BUCKET) return;
  const owner = { userId: project.user_id, appId: project.id };
  const lock = storageMetered(env) ? await acquireStorageLock(env, project.id) : null;
  try {
    // Source, assets and operation evidence use objects/ in this same prefix.
    // Only Git bundles and their pack parts have moved to GitHub.
    for (const kind of ['bundles', 'parts']) for (;;) {
      const page = await listStoredObjects(env, owner, { prefix: `build-git/${project.user_id}/${project.id}/${kind}/`, limit: 1000 });
      if (!page.objects.length) break;
      await deleteStoredObjects(env, owner, page.objects.map(object => object.key));
    }
    await env.DB.prepare('UPDATE projects SET github_cleanup_pending=0 WHERE id=? AND user_id=? AND github_repo IS NOT NULL').bind(project.id, project.user_id).run();
  } finally { if (lock) await releaseStorageLock(env, project.id, lock); }
}
export async function cleanupLinkedGithubHistory(env: Env) {
  const { results } = await env.DB.prepare('SELECT * FROM projects WHERE github_repo IS NOT NULL AND github_cleanup_pending=1 LIMIT 20').all<GithubProject>();
  for (const project of results) await cleanupGithubHostedHistory(env, project).catch(() => console.error('github_history_cleanup_deferred', { projectId: project.id }));
}

function publicVersion(commit: any, verified: string | null = null) {
  return { id: commit.sha as string, commitId: commit.sha as string, parentVersionId: commit.parents?.[0]?.sha ?? null,
    message: commit.message ?? commit.commit?.message ?? '', verified: commit.sha === verified,
    createdAt: commit.committer?.date ?? commit.commit?.committer?.date ?? new Date(0).toISOString() };
}
export async function listGithubVersions(env: Env, project: GithubProject, verified: string | null) {
  const token = await githubBuildUserToken(env, project.user_id);
  const head = await githubHead(project.github_repo!, project.github_branch!, token);
  const commits = head ? await githubBuildAPI(`/repos/${project.github_repo}/commits?sha=${head}&per_page=100`, token) : [];
  if (!Array.isArray(commits)) throw new BuildError('github_unavailable');
  return { versions: commits.map(commit => publicVersion(commit, verified)), versionId: head, verifiedVersionId: verified };
}
export async function githubVersion(env: Env, project: GithubProject, sha: string, verified: string | null = null) {
  if (!commitId(sha)) throw new BuildError('version_not_found', 404);
  const token = await githubBuildUserToken(env, project.user_id);
  const head = await githubHead(project.github_repo!, project.github_branch!, token);
  if (!head) throw new BuildError('version_not_found', 404);
  if (sha !== head) {
    const comparison = await githubBuildAPI(`/repos/${project.github_repo}/compare/${sha}...${head}`, token);
    if (!['ahead', 'identical'].includes(comparison.status)) throw new BuildError('version_not_found', 404);
  }
  const commit = await githubBuildAPI(`/repos/${project.github_repo}/git/commits/${sha}`, token);
  const entries = (await githubTree(project.github_repo!, sha, token)).filter(entry => entry.type === 'blob');
  const info = (entry: TreeEntry) => ({ path: entry.path, size: entry.size ?? 0, type: /\.(png|jpe?g|gif|webp|ico)$/i.test(entry.path) ? 'image' as const : 'text' as const });
  return { token, commit, entries, files: entries.map(info), version: publicVersion(commit, verified) };
}
export async function githubVersionDetail(env: Env, project: GithubProject, sha: string, verified: string | null = null) {
  const detail = await githubVersion(env, project, sha, verified);
  const parent = detail.commit.parents?.[0]?.sha;
  const old = new Map((parent ? await githubTree(project.github_repo!, parent, detail.token) : []).filter(entry => entry.type === 'blob').map(entry => [entry.path, entry]));
  const next = new Map(detail.entries.map(entry => [entry.path, entry]));
  return { version: detail.version, files: detail.files,
    changes: [...new Set([...old.keys(), ...next.keys()])].sort().filter(path => old.get(path)?.sha !== next.get(path)?.sha)
      .map(path => ({ path, type: !old.has(path) ? 'added' : !next.has(path) ? 'deleted' : 'modified', fileType: /\.(png|jpe?g|gif|webp|ico)$/i.test(path) ? 'image' : 'text' })) };
}
export async function serveGithubVersionFile(env: Env, project: GithubProject, sha: string, path: string, headers: HeadersInit) {
  const detail = await githubVersion(env, project, sha);
  const entry = detail.entries.find(entry => entry.path === path);
  if (!entry) throw new BuildError('file_not_found', 404);
  const bytes = await blobBytes(project.github_repo!, entry, detail.token);
  const type = /\.png$/i.test(path) ? 'image/png' : /\.jpe?g$/i.test(path) ? 'image/jpeg' : /\.webp$/i.test(path) ? 'image/webp' : /\.gif$/i.test(path) ? 'image/gif' : 'text/plain; charset=utf-8';
  return new Response(bytes, { headers: { ...headers, 'Content-Type': type, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
}
export async function githubRestoreVersion(env: Env, project: GithubProject, sha: string): Promise<BuildGitVersion> {
  const detail = await githubVersion(env, project, sha);
  const files = await githubSource(project.github_repo!, sha, detail.token);
  const lock = detail.entries.find(entry => entry.path === 'package-lock.json');
  const lockfile = lock ? decoder.decode(await blobBytes(project.github_repo!, lock, detail.token)) : null;
  return { id: sha, app_id: project.id, commit_id: sha, parent_version_id: detail.version.parentVersionId, bundle_key: '',
    source_json: JSON.stringify(files), lockfile, assets_json: '[]', message: detail.version.message, verified: 0, created_at: detail.version.createdAt };
}
export async function syncGithubSource(env: Env, params: BuildParams) {
  const project = await githubProject(env, params.userId, params.appId);
  if (!project?.github_repo) return null;
  const token = await githubBuildUserToken(env, params.userId);
  const head = await githubHead(project.github_repo, project.github_branch!, token);
  if (head === project.github_commit_id) return project;
  if (!head) throw new BuildError('github_branch_conflict', 409);
  const remote = await githubSource(project.github_repo, head, token);
  const app = await env.DB.prepare('SELECT source_json,active_turn_id FROM build_apps WHERE id=? AND user_id=?').bind(params.appId, params.userId)
    .first<{ source_json: string; active_turn_id: string | null }>();
  if (app?.active_turn_id !== params.turnId) throw new BuildError('build_interrupted', 409);
  const working = await readBuildSource(env, params, app.source_json);
  const base = project.github_commit_id ? await githubSource(project.github_repo, project.github_commit_id, token) : {};
  const files: BuildFiles = {};
  for (const path of new Set([...Object.keys(base), ...Object.keys(working), ...Object.keys(remote)])) {
    const localChange = working[path] !== base[path], remoteChange = remote[path] !== base[path];
    if (localChange && remoteChange && working[path] !== remote[path]) throw new BuildError('github_source_conflict', 409, `Conflicting file: ${path}`);
    const value = localChange ? working[path] : remote[path];
    if (value !== undefined) files[path] = value;
  }
  try { validateBuildFiles(files); } catch { throw new BuildError('github_source_limit', 413); }
  const source = await storeBuildSource(env, params, files);
  await env.DB.batch([
    env.DB.prepare(`UPDATE build_apps SET source_json=? WHERE id=? AND user_id=? AND active_turn_id=?`)
      .bind(source, params.appId, params.userId, params.turnId),
    env.DB.prepare(`UPDATE projects SET github_commit_id=?,github_paths_json=? WHERE id=? AND user_id=? AND github_commit_id IS ?
      AND EXISTS(SELECT 1 FROM build_apps WHERE id=? AND active_turn_id=?)`)
      .bind(head, JSON.stringify([...new Set([...JSON.parse(project.github_paths_json), ...Object.keys(files)])]), params.appId, params.userId, project.github_commit_id, params.appId, params.turnId),
  ]);
  return { ...project, github_commit_id: head, github_paths_json: JSON.stringify([...new Set([...JSON.parse(project.github_paths_json), ...Object.keys(files)])]) };
}
export async function hydrateGithubGit(env: Env, params: BuildParams, runtime: BuildGitRuntime, project: GithubProject) {
  if (!project.github_commit_id) return;
  const token = await githubBuildUserToken(env, params.userId);
  let pack: Uint8Array;
  try { pack = await downloadGitPack(project.github_repo!, project.github_commit_id, token); }
  catch (error) { throw new BuildError(error instanceof Error ? error.message : 'github_unavailable'); }
  const folder = '/workspace/mainbrella-github';
  const setup = await runtime.run('github-hydrate-directories', `mkdir -p ${folder} /workspace/app`);
  if (setup.status !== 'succeeded') throw new BuildError('github_unavailable');
  const packs: string[] = [];
  for (let offset = 0; offset < pack.length; offset += BUILD_MAX_FILE_BYTES) {
    const path = `${folder}/source-${packs.length}.pack`;
    await runtime.write(path, new Uint8Array(pack.slice(offset, offset + BUILD_MAX_FILE_BYTES)));
    packs.push(path);
  }
  await runtime.write(`${folder}/hydrate.cjs`, `const fs=require('node:fs'),{spawnSync}=require('node:child_process');
const input=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),repo=input.worktree;
const env={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'};
for(const key of ['GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES','GIT_CONFIG_COUNT'])delete env[key];
function git(args,stdin){const r=spawnSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd:repo,env,input:stdin});if(r.status!==0)throw new Error('GitHub checkout failed');return r.stdout.toString().trim();}
fs.rmSync(repo+'/.git',{recursive:true,force:true});git(['init','--quiet']);git(['index-pack','--stdin'],Buffer.concat(input.packs.map(part=>fs.readFileSync(part))));
git(['cat-file','-e',input.sha+'^{commit}']);fs.writeFileSync(repo+'/.git/shallow',input.sha+'\\n');git(['update-ref','refs/heads/'+input.branch,input.sha]);git(['symbolic-ref','HEAD','refs/heads/'+input.branch]);
git(['reset','--hard',input.sha]);git(['remote','add','origin','https://github.com/'+input.repo+'.git']);
`);
  await runtime.write(`${folder}/input.json`, JSON.stringify({ sha: project.github_commit_id, branch: project.github_branch, repo: project.github_repo,
    worktree: '/workspace/app', packs }));
  const result = await runtime.run('github-hydrate', `node ${folder}/hydrate.cjs ${folder}/input.json`);
  if (result.status !== 'succeeded') throw new BuildError('github_unavailable');
}


import { BuildError, type BuildFiles } from './build-contract';

export type BuildStorageOwner = { userId: string; appId: string };
export type BuildObjectRef = { $r2: string; size: number; sha256: string };
export type BuildStoredFile = BuildObjectRef & { path: string; type: 'text' | 'image' };
export type BuildFileInfo = { path: string; size: number; type: 'text' | 'image' };
const encoder = new TextEncoder();
export const canonicalBuildSource = (files: BuildFiles) => JSON.stringify(Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))));
export const buildStoragePrefix = ({ userId, appId }: BuildStorageOwner) => `build-git/${userId}/${appId}/`;
export async function buildContentHash(bytes: Uint8Array<ArrayBuffer>) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export function buildObjectRef(value: unknown): BuildObjectRef | null {
  if (!value || typeof value !== 'object') return null;
  const ref = value as BuildObjectRef;
  return typeof ref.$r2 === 'string' && Number.isSafeInteger(ref.size) && ref.size >= 0 && /^[a-f0-9]{64}$/.test(ref.sha256) ? ref : null;
}
function checkRef(owner: BuildStorageOwner, ref: BuildObjectRef) {
  if (ref.$r2 !== `${buildStoragePrefix(owner)}objects/${ref.sha256}`) throw new BuildError('build_source_unavailable');
}
export async function storeBuildObject(env: Env, owner: BuildStorageOwner, bytes: Uint8Array<ArrayBuffer>, contentType = 'text/plain; charset=utf-8'): Promise<BuildObjectRef> {
  if (!env.BUCKET) throw new BuildError('build_source_unavailable');
  const sha256 = await buildContentHash(bytes), ref = { $r2: `${buildStoragePrefix(owner)}objects/${sha256}`, size: bytes.length, sha256 };
  try {
    await env.BUCKET.put(ref.$r2, bytes, { onlyIf: { etagDoesNotMatch: '*' }, sha256, httpMetadata: { contentType } });
  } catch { throw new BuildError('build_source_unavailable'); }
  return ref;
}
export async function getBuildObject(env: Env, owner: BuildStorageOwner, ref: BuildObjectRef) {
  checkRef(owner, ref);
  const object = await env.BUCKET?.get(ref.$r2);
  if (!object || object.size !== ref.size) throw new BuildError('build_source_unavailable');
  return object;
}
export async function readBuildObject(env: Env, owner: BuildStorageOwner, ref: BuildObjectRef) {
  const bytes = new Uint8Array(await (await getBuildObject(env, owner, ref)).arrayBuffer());
  if (await buildContentHash(bytes) !== ref.sha256) throw new BuildError('build_source_unavailable');
  return bytes;
}
export async function storeBuildText(env: Env, owner: BuildStorageOwner, text: string) {
  return JSON.stringify(await storeBuildObject(env, owner, encoder.encode(text)));
}
export async function readBuildText(env: Env, owner: BuildStorageOwner, stored: string) {
  let parsed: unknown;
  try { parsed = JSON.parse(stored); } catch { return stored; }
  const ref = buildObjectRef(parsed);
  return ref ? new TextDecoder().decode(await readBuildObject(env, owner, ref)) : stored;
}
export async function storeBuildSource(env: Env, owner: BuildStorageOwner, files: BuildFiles) {
  const sorted = Object.entries(files).sort(([a], [b]) => a.localeCompare(b));
  const entries: BuildStoredFile[] = [];
  for (const [path, text] of sorted) entries.push({ path, type: 'text', ...await storeBuildObject(env, owner, encoder.encode(text)) });
  return JSON.stringify(await storeBuildObject(env, owner, encoder.encode(JSON.stringify({ schemaVersion: 1, files: entries })), 'application/json'));
}
export async function buildSourceEntries(env: Env, owner: BuildStorageOwner, stored: string): Promise<(BuildStoredFile & { inline?: string })[]> {
  const parsed = JSON.parse(stored), ref = buildObjectRef(parsed);
  if (!ref) return Promise.all(Object.entries(parsed as BuildFiles).map(async ([path, inline]) => ({ path, type: 'text' as const, inline, $r2: '', size: encoder.encode(inline).length, sha256: await buildContentHash(encoder.encode(inline)) })));
  const manifest = JSON.parse(new TextDecoder().decode(await readBuildObject(env, owner, ref)));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || manifest.files.length > 1024) throw new BuildError('build_source_unavailable');
  const paths = new Set<string>();
  for (const file of manifest.files) {
    if (!buildObjectRef(file) || typeof file.path !== 'string' || paths.has(file.path) || file.type !== 'text') throw new BuildError('build_source_unavailable');
    checkRef(owner, file); paths.add(file.path);
  }
  return manifest.files;
}
export async function readBuildSource(env: Env, owner: BuildStorageOwner, stored: string): Promise<BuildFiles> {
  const entries = await buildSourceEntries(env, owner, stored), files: BuildFiles = {};
  for (const file of entries) files[file.path] = file.inline ?? new TextDecoder().decode(await readBuildObject(env, owner, file));
  return files;
}
export async function buildTextEntry(owner: BuildStorageOwner, path: string, stored: string, type: 'text' | 'image' = 'text'): Promise<BuildStoredFile & { inline?: string }> {
  let parsed: unknown;
  try { parsed = JSON.parse(stored); } catch { /* Legacy text. */ }
  const ref = buildObjectRef(parsed);
  if (ref) { checkRef(owner, ref); return { path, type, ...ref }; }
  const bytes = encoder.encode(stored), sha256 = await buildContentHash(bytes);
  return { path, type, inline: stored, $r2: `${buildStoragePrefix(owner)}objects/${sha256}`, size: bytes.length, sha256 };
}
export async function serveBuildFile(env: Env, owner: BuildStorageOwner, file: BuildStoredFile & { inline?: string }, cors: HeadersInit) {
  const headers = { ...cors, 'Content-Type': file.type === 'image' ? 'image/jpeg' : 'text/plain; charset=utf-8',
    'Content-Length': String(file.size), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
  if (file.inline !== undefined) return new Response(file.inline, { headers });
  const object = await getBuildObject(env, owner, file);
  return new Response(object.body, { headers });
}

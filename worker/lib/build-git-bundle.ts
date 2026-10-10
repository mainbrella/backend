import { BuildError } from './build-contract';
import { getStoredObject, type StorageOwner } from './r2-storage';

export type BuildGitPart = { key: string; size: number; sha256: string };
type BundleData = { commitId: string; size: number; parts: BuildGitPart[] };
export type BuildGitBundle = BundleData & ({ schemaVersion: 1 } | {
  schemaVersion: 2; prerequisiteCommitId: string | null; previousBundleKey: string | null;
});
export const buildGitPrefix = ({ userId, appId }: StorageOwner) => `build-git/${userId}/${appId}/`;
export const gitCommitId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

export function validateBuildGitBundle(owner: StorageOwner, value: unknown): BuildGitBundle {
  const bundle = value as BuildGitBundle;
  const prefix = buildGitPrefix(owner);
  if (!bundle || ![1, 2].includes(bundle.schemaVersion) || !gitCommitId(bundle.commitId)
    || !Number.isSafeInteger(bundle.size) || bundle.size < 1 || bundle.size > 128 * 1024 * 1024
    || !Array.isArray(bundle.parts) || !bundle.parts.length || bundle.parts.length > 128
    || bundle.parts.some(part => !part || typeof part.key !== 'string' || !part.key.startsWith(`${prefix}parts/`)
      || typeof part.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(part.sha256)
      || !Number.isSafeInteger(part.size) || part.size < 1 || part.size > 1024 * 1024)
    || bundle.parts.reduce((total, part) => total + part.size, 0) !== bundle.size) throw new BuildError('build_git_unavailable');
  if (bundle.schemaVersion === 2 && !(bundle.prerequisiteCommitId === null && bundle.previousBundleKey === null
    || gitCommitId(bundle.prerequisiteCommitId) && typeof bundle.previousBundleKey === 'string'
      && bundle.previousBundleKey.startsWith(`${prefix}bundles/`) && bundle.prerequisiteCommitId !== bundle.commitId))
    throw new BuildError('build_git_unavailable');
  return bundle;
}

export async function readBuildGitBundle(env: Env, owner: StorageOwner, key: string) {
  if (!env.BUCKET || !key.startsWith(`${buildGitPrefix(owner)}bundles/`)) throw new BuildError('build_git_unavailable');
  const object = await getStoredObject(env, owner, key);
  if (!object) throw new BuildError('build_git_unavailable');
  let value: unknown;
  try { value = await object.json(); } catch { throw new BuildError('build_git_unavailable'); }
  return validateBuildGitBundle(owner, value);
}

export async function readBuildGitChain(env: Env, owner: StorageOwner, key: string) {
  const bundles: BuildGitBundle[] = [], visited = new Set<string>();
  let next: string | null = key;
  while (next !== null) {
    if (visited.has(next)) throw new BuildError('build_git_unavailable');
    visited.add(next);
    const bundle = await readBuildGitBundle(env, owner, next);
    const child = bundles.at(-1);
    // Legacy full bundles can back an ancestor version as well as their head.
    if (child?.schemaVersion === 2 && bundle.schemaVersion === 2 && child.prerequisiteCommitId !== bundle.commitId)
      throw new BuildError('build_git_unavailable');
    bundles.push(bundle);
    next = bundle.schemaVersion === 2 ? bundle.previousBundleKey : null;
  }
  return bundles.reverse();
}

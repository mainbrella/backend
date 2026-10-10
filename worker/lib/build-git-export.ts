import { createHash } from 'node:crypto';
import { BuildError } from './build-contract';
import { buildContentHash } from './build-storage';
import { getStoredObject, type StorageOwner } from './r2-storage';
import type { BuildGitBundle, BuildGitPart } from './build-git-bundle';

async function readPart(env: Env, owner: StorageOwner, part: BuildGitPart) {
  const object = await getStoredObject(env, owner, part.key);
  if (!object || object.size !== part.size) throw new BuildError('build_git_unavailable');
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.length !== part.size || await buildContentHash(bytes) !== part.sha256) throw new BuildError('build_git_unavailable');
  return bytes;
}

// Join complete packed-object sections, without decompressing or repacking.
// The initial pack is self-contained; increments store whole compressed
// objects (see build-git-program). This avoids conflicting delta references
// when Git re-emits an old object during a restore. Replace pack headers and
// trailers with one object count and checksum, preserving sandbox-free reads.
// Format: https://git-scm.com/docs/gitformat-pack
export async function exportBuildGitBundles(env: Env, owner: StorageOwner, bundles: BuildGitBundle[], commitId: string, headers: HeadersInit) {
  const sections: { bundle: BuildGitBundle; offset: number; first?: Uint8Array }[] = [];
  let count = 0, packedSize = 0, cachedBytes = 0;
  for (const bundle of bundles) {
    const first = await readPart(env, owner, bundle.parts[0]);
    let end = -1;
    for (let i = 0; i + 1 < Math.min(first.length, 4096); i++) if (first[i] === 10 && first[i + 1] === 10) { end = i; break; }
    const lines = new TextDecoder().decode(first.subarray(0, Math.max(end, 0))).split('\n');
    const expected = bundle.schemaVersion === 2 && bundle.prerequisiteCommitId ? [bundle.prerequisiteCommitId] : [];
    const prerequisites = lines.filter(line => line.startsWith('-')).map(line => line.slice(1, 41));
    const offset = end + 2;
    if (end < 0 || lines[0] !== '# v2 git bundle' || JSON.stringify(prerequisites) !== JSON.stringify(expected)
      || lines.filter(line => !line.startsWith('-')).slice(1).join('\n') !== `${bundle.commitId} refs/heads/main`
      || first.length < offset + 12 || bundle.size < offset + 32
      || new TextDecoder().decode(first.subarray(offset, offset + 4)) !== 'PACK') throw new BuildError('build_git_unavailable');
    const view = new DataView(first.buffer, first.byteOffset + offset, 12);
    if (view.getUint32(4) !== 2) throw new BuildError('build_git_unavailable');
    count += view.getUint32(8);
    if (count > 0xffffffff) throw new BuildError('build_git_unavailable');
    packedSize += bundle.size - offset - 32;
    // Keep small increments for the stream, with a bounded header cache.
    const cached = cachedBytes + first.length <= 4 * 1024 * 1024;
    if (cached) cachedBytes += first.length;
    sections.push({ bundle, offset, ...(cached ? { first } : {}) });
  }
  const header = new TextEncoder().encode(`# v2 git bundle\n${commitId} refs/heads/main\n\n`);
  const packHeader = new Uint8Array(12);
  packHeader.set(new TextEncoder().encode('PACK'));
  const view = new DataView(packHeader.buffer);
  view.setUint32(4, 2); view.setUint32(8, count);
  const checksum = createHash('sha1'); checksum.update(packHeader);

  async function* chunks() {
    yield header; yield packHeader;
    for (const section of sections) {
      const { bundle, offset } = section, original = createHash('sha1'), trailer = new Uint8Array(20);
      let position = 0;
      for (const [index, part] of bundle.parts.entries()) {
        const bytes = index === 0 && section.first ? section.first : await readPart(env, owner, part);
        delete section.first;
        const end = position + bytes.length, packEnd = bundle.size - 20;
        const hashStart = Math.max(offset - position, 0), hashEnd = Math.min(packEnd - position, bytes.length);
        if (hashEnd > hashStart) original.update(bytes.subarray(hashStart, hashEnd));
        if (end > packEnd) trailer.set(bytes.subarray(Math.max(packEnd - position, 0)), Math.max(position - packEnd, 0));
        const start = Math.max(offset + 12 - position, 0);
        if (hashEnd > start) {
          const objects = bytes.subarray(start, hashEnd);
          checksum.update(objects); yield objects;
        }
        position = end;
      }
      if (!original.digest().equals(trailer)) throw new BuildError('build_git_unavailable');
    }
    yield new Uint8Array(checksum.digest());
  }
  const iterator = chunks();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await iterator.next();
        if (chunk.done) controller.close(); else controller.enqueue(chunk.value);
      } catch { controller.error(new Error('Repository unavailable')); }
    },
    async cancel() { await iterator.return(undefined); },
  });
  return new Response(body, { headers: { ...headers, 'Content-Type': 'application/octet-stream',
    'Content-Length': String(header.length + 12 + packedSize + 20),
    'Content-Disposition': 'attachment; filename="mainbrella-app.bundle"', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
}

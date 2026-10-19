import { z } from 'zod';

export const repoName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/)
  .refine(value => !['.', '..'].includes(value.split('/')[1]));

export class GitPackError extends Error {
  constructor(message: string, public status = 503) { super(message); }
}

const encoder = new TextEncoder();
export const MAX_IMPORT_PACK_BYTES = 32 * 1024 * 1024;
const packet = (text: string) => (encoder.encode(text).byteLength + 4).toString(16).padStart(4, '0') + text;
export function gitFetchBody(commit: string) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new GitPackError('invalid_request', 400);
  return packet(`want ${commit} side-band-64k ofs-delta no-progress\n`) + packet('deepen 1\n') + '0000' + packet('done\n');
}

// Only pack bytes cross into the guest. GitHub authorization stays in the Worker.
// Shallow Git objects preserve the exact base commit for future local commits.
export async function readGitPack(stream: ReadableStream<Uint8Array> | null): Promise<Uint8Array> {
  if (!stream) throw new GitPackError('github_unavailable');
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let pending = new Uint8Array(), total = 0, wireBytes = 0, flushed = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      wireBytes += value.byteLength;
      if (wireBytes > MAX_IMPORT_PACK_BYTES + 1024 * 1024) throw new GitPackError('repository_too_large', 413);
      const joined = new Uint8Array(pending.length + value.length); joined.set(pending); joined.set(value, pending.length);
      let offset = 0;
      while (offset + 4 <= joined.length) {
        const header = new TextDecoder().decode(joined.subarray(offset, offset + 4));
        if (!/^[0-9a-f]{4}$/.test(header)) throw new GitPackError('github_unavailable');
        const size = parseInt(header, 16);
        if (size === 0) { if (total) flushed = true; offset += 4; continue; }
        if (size < 5 || size > 65520 || flushed) throw new GitPackError('github_unavailable');
        if (offset + size > joined.length) break;
        const data = joined.subarray(offset + 4, offset + size);
        if (data[0] === 1) {
          total += data.length - 1;
          if (total > MAX_IMPORT_PACK_BYTES) throw new GitPackError('repository_too_large', 413);
          chunks.push(data.slice(1));
        } else if (data[0] === 3 || new TextDecoder().decode(data).startsWith('ERR ')) throw new GitPackError('github_repository_access_required', 400);
        offset += size;
      }
      pending = joined.slice(offset);
    }
    if (pending.length || !flushed || total < 32) throw new GitPackError('github_unavailable');
    const pack = new Uint8Array(total);
    let offset = 0; for (const chunk of chunks) { pack.set(chunk, offset); offset += chunk.length; }
    if (new TextDecoder().decode(pack.subarray(0, 4)) !== 'PACK') throw new GitPackError('github_unavailable');
    return pack;
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function downloadGitPack(repo: string, commit: string, token: string): Promise<Uint8Array> {
  if (!repoName.safeParse(repo).success) throw new GitPackError('invalid_request', 400);
  let response: Response;
  try {
    response = await fetch(`https://github.com/${repo}.git/git-upload-pack`, { method: 'POST', redirect: 'manual',
      signal: AbortSignal.timeout(45_000), headers: { Authorization: `Basic ${btoa(`x-access-token:${token}`)}`,
        'Content-Type': 'application/x-git-upload-pack-request', Accept: 'application/x-git-upload-pack-result', 'User-Agent': 'Mainbrella-Import' },
      body: gitFetchBody(commit) });
  } catch { throw new GitPackError('github_unavailable'); }
  if ([401, 403, 404].includes(response.status)) throw new GitPackError('github_repository_access_required', 400);
  if (!response.ok || !response.headers.get('content-type')?.startsWith('application/x-git-upload-pack-result')) throw new GitPackError('github_unavailable');
  return readGitPack(response.body);
}

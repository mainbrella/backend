import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export function buildStorageFixture(env: Env) {
  const objects = new Map<string, Uint8Array<ArrayBuffer>>(), puts: string[] = [];
  const reads: { key: string; buffered: boolean; streamed: boolean }[] = [];
  env.BUCKET = {
    async put(key: string, value: string | ArrayBuffer | Uint8Array, options?: R2PutOptions) {
      puts.push(key);
      if (options?.onlyIf && 'etagDoesNotMatch' in options.onlyIf && options.onlyIf.etagDoesNotMatch === '*' && objects.has(key)) return null;
      const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value).slice();
      if (options?.sha256) assert.equal(createHash('sha256').update(bytes).digest('hex'), options.sha256);
      objects.set(key, bytes); return {};
    },
    async get(key: string) {
      const bytes = objects.get(key);
      const read = { key, buffered: false, streamed: false }; reads.push(read);
      if (!bytes) return null;
      return { size: bytes.length, get body() { read.streamed = true; return new Response(bytes.slice()).body; },
        async arrayBuffer() { read.buffered = true; return bytes.slice().buffer; },
        async json() { read.buffered = true; return JSON.parse(new TextDecoder().decode(bytes)); } };
    },
    async list({ prefix, limit = 1000 }: R2ListOptions = {}) {
      const keys = [...objects.keys()].filter(key => key.startsWith(prefix ?? '')).sort();
      return { objects: keys.slice(0, limit).map(key => ({ key })), truncated: keys.length > limit };
    },
    async delete(keys: string | string[]) { for (const key of typeof keys === 'string' ? [keys] : keys) objects.delete(key); },
  } as unknown as R2Bucket;
  return { objects, puts, reads };
}

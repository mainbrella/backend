// Raw bytes throughout: files must never pass through a text decoder.
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_FILE_PATH_BYTES = 4096;
export const FILE_TIMEOUT_MS = 30_000;

export function validFilePath(path) {
  return typeof path === 'string' && path.startsWith('/') && !path.includes('\0')
    && new TextEncoder().encode(path).byteLength <= MAX_FILE_PATH_BYTES
    && path.split('/').slice(1).every(part => part && part !== '.' && part !== '..');
}

export async function readFileBytes(stream, limit = MAX_FILE_BYTES, signal) {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const bytes = new Uint8Array(limit);
  let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (signal?.aborted) throw new Error('request_aborted');
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > limit) throw new Error('file_too_large');
      bytes.set(value, size);
      size += value.byteLength;
    }
    if (signal?.aborted) throw new Error('request_aborted');
    return bytes.slice(0, size);
  } finally {
    signal?.removeEventListener('abort', cancel);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

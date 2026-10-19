export async function boundedBody(body, limit = 1024 * 1024, signal) {
  signal?.throwIfAborted();
  if (!body) return undefined;
  const reader = body.getReader(), chunks = [];
  let onAbort;
  const aborted = signal && new Promise((_, reject) => {
    onAbort = () => {
      reject(signal.reason ?? new Error('private_service_timeout'));
      void reader.cancel(signal.reason).catch(() => {});
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await (aborted ? Promise.race([reader.read(), aborted]) : reader.read());
      signal?.throwIfAborted();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error('request_too_large');
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    void reader.cancel().catch(() => {}); reader.releaseLock();
  }
}


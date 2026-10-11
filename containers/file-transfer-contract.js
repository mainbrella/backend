import { validFilePath } from './file-contract.js';

// Kept below common ingress request-size limits. Each transfer occupies one
// execution slot; bytes flow under backpressure instead of a file-sized buffer.
export const MAX_TRANSFER_BYTES = 64 * 1024 * 1024;
export const TRANSFER_TIMEOUT_MS = 5 * 60_000;

export function transferSize(value) {
  return typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)
    && Number.isSafeInteger(Number(value)) && Number(value) <= MAX_TRANSFER_BYTES ? Number(value) : null;
}

export function validTransferPath(path) {
  return validFilePath(path) && new TextDecoder().decode(new TextEncoder().encode(path)) === path;
}

// An exact length makes truncated input fail closed, before an atomic upload can
// be committed, and makes a truncated download visible to stream consumers.
export function exactByteStream(stream, size, signal) {
  const reader = stream?.getReader();
  let count = 0, finished = false, output;
  const release = () => {
    signal?.removeEventListener('abort', abort);
    try { reader?.releaseLock(); } catch {}
  };
  const cancel = async reason => { try { await reader?.cancel(reason); } catch {} release(); };
  const abort = () => {
    if (finished) return;
    finished = true;
    output.error(new Error('request_aborted'));
    void cancel('request_aborted');
  };
  return new ReadableStream({
    start(controller) {
      output = controller;
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    },
    async pull(controller) {
      try {
        const { done, value } = reader ? await reader.read() : { done: true };
        if (finished) return;
        if (done) {
          if (count !== size) throw new Error('file_size_mismatch');
          finished = true; release(); controller.close(); return;
        }
        count += value.byteLength;
        if (count > size) throw new Error('file_size_mismatch');
        controller.enqueue(value);
      } catch (error) {
        if (!finished) { finished = true; controller.error(error); }
        await cancel(error);
      }
    },
    async cancel(reason) { finished = true; await cancel(reason); },
  });
}

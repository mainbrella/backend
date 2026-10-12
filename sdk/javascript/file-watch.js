import { NATIVE_WATCH_GUEST } from './watch-guest.js';

const encoder = new TextEncoder();
const validFilename = value => value === null || typeof value === 'string' && value && !value.startsWith('/')
  && !value.includes('\0') && value.split('/').every(part => part && part !== '.' && part !== '..')
  && encoder.encode(value).length <= 4096 && new TextDecoder().decode(encoder.encode(value)) === value;

export async function watchNative(sandbox, path, { recursive = true, timeoutMs = 900000, idempotencyKey = crypto.randomUUID() } = {}, ErrorType) {
  if (typeof recursive !== 'boolean' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 900000
    || typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(idempotencyKey)
    || encoder.encode(path).length > 4096 || new TextDecoder().decode(encoder.encode(path)) !== path) throw new ErrorType('invalid_file_watch_options');
  const execution = await sandbox.commands.start(['node', '-e', NATIVE_WATCH_GUEST, path, String(recursive)], { timeoutMs, idempotencyKey });
  let pending = '', queued = [], reading = false, closed = false;
  return {
    execution, idempotencyKey,
    async *events({ signal } = {}) {
      if (reading) throw new ErrorType('file_watch_already_reading');
      if (closed) return;
      reading = true;
      try {
        while (queued.length) yield queued.shift();
        for await (const item of execution.events({ signal })) {
          if (item.type === 'stderr') throw new ErrorType('file_watch_unavailable');
          if (item.type === 'status') {
            const state = item.execution;
            if (state.outputTruncated) throw new ErrorType('file_watch_output_limit');
            if (state.timedOut) throw new ErrorType('file_watch_timeout');
            if (!['starting', 'running'].includes(state.status)) {
              if (pending || !['succeeded', 'canceled'].includes(state.status)) throw new ErrorType('file_watch_failed');
              return;
            }
            continue;
          }
          pending += item.data;
          if (pending.length > 65536) throw new ErrorType('invalid_file_watch_response');
          let boundary;
          while ((boundary = pending.indexOf('\n')) !== -1) {
            if (boundary > 16384) throw new ErrorType('invalid_file_watch_response');
            let event;
            try { event = JSON.parse(pending.slice(0, boundary)); } catch { throw new ErrorType('invalid_file_watch_response'); }
            pending = pending.slice(boundary + 1);
            if (event?.type === 'error') {
              if (!['file_watch_output_limit', 'file_watch_directory_limit', 'file_watch_filename_invalid', 'file_watch_unavailable'].includes(event.code)) throw new ErrorType('invalid_file_watch_response');
              throw new ErrorType(event.code);
            }
            if (!(event?.type === 'ready' && event.path === path && event.recursive === recursive)
              && !(['rename', 'change'].includes(event?.type) && validFilename(event.filename))) throw new ErrorType('invalid_file_watch_response');
            queued.push(event);
          }
          while (queued.length) yield queued.shift();
        }
      } finally { reading = false; }
    },
    async close() {
      if (closed) return { closed: true };
      const result = await execution.cancel();
      if (!['succeeded', 'failed', 'canceled', 'timed_out', 'output_limit', 'interrupted'].includes(result?.status)) throw new ErrorType('file_watch_cleanup_unconfirmed');
      closed = true;
      return { closed: true };
    },
  };
}

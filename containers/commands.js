import { MAX_EXECUTIONS, MAX_OUTPUT_BYTES, readCommandBody, validCommand } from './command-contract.js';

// Foreground commands have bounded lifetime and output. A transport failure may
// hide their result; callers must not retry commands with side effects blindly.
export async function executeCommand(controller, request, active, timers = globalThis) {
  if (request.method !== 'POST') return controller.respond({ error: 'method_not_allowed' }, 405);
  const createdAt = request.headers.get('x-exec-created-at');
  const expiryText = request.headers.get('x-exec-expires-at');
  const expiresAt = expiryText && /^\d+$/.test(expiryText) ? Number(expiryText) : NaN;
  if (!createdAt || !Number.isSafeInteger(expiresAt)) return controller.respond({ error: 'forbidden' }, 403);
  let body;
  try { body = await readCommandBody(request); } catch { return controller.respond({ error: 'invalid_request' }, 400); }
  if (!validCommand(body)) return controller.respond({ error: 'invalid_request' }, 400);
  const metadata = await controller.getTerminalMetadata(createdAt, expiresAt);
  if (!metadata) return controller.respond({ error: 'container_not_running' }, 409);
  if (active.size >= MAX_EXECUTIONS) return controller.respond({ error: 'execution_limit' }, 429);

  const abort = new AbortController();
  let process;
  let reason;
  let rejectStopped;
  const stopped = new Promise((_, reject) => { rejectStopped = reject; });
  // Attach immediately so an early disconnect cannot create an unhandled rejection.
  void stopped.catch(() => {});
  const stop = (value) => {
    if (reason) return;
    reason = value;
    abort.abort();
    try { process?.kill(9); } catch { /* already exited */ }
    rejectStopped(new Error(value));
  };
  const session = { close: () => stop('container_not_running') };
  active.add(session);
  const disconnected = () => stop('execution_unavailable');
  request.signal.addEventListener('abort', disconnected, { once: true });
  const timer = timers.setTimeout(() => stop('timed_out'), Math.max(0,
    Math.min(body.timeoutMs ?? 30_000, metadata.expiresAt - controller.now())));
  const result = { stdout: '', stderr: '', exitCode: null, timedOut: false, outputTruncated: false };
  let bytes = 0;
  const readers = [];
  async function pump(stream, key) {
    if (!stream) throw new Error('missing_stream');
    const reader = stream.getReader();
    readers.push(reader);
    const decoder = new TextDecoder();
    while (!reason) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = MAX_OUTPUT_BYTES - bytes;
      const chunk = value.subarray(0, remaining);
      bytes += chunk.byteLength;
      result[key] += decoder.decode(chunk, { stream: true });
      if (value.byteLength > remaining) {
        result[key] += decoder.decode();
        stop('output_limit');
        return;
      }
    }
    result[key] += decoder.decode();
  }
  try {
    if (request.signal.aborted) disconnected();
    const starting = controller.startTerminalProcess(createdAt, expiresAt,
      ['/bin/sh', '-lc', body.command], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', signal: abort.signal });
    // A process returned after timeout must also be terminated.
    void starting.then(value => { if (reason) { try { value.kill(9); } catch {} } }).catch(() => {});
    process = await Promise.race([starting, stopped]);
    if (!await controller.touchTerminalActivity(createdAt)) return controller.respond({ error: 'container_not_running' }, 409);
    await Promise.race([process.stdin?.close(), stopped]);
    const [exitCode] = await Promise.race([
      Promise.all([process.exitCode, pump(process.stdout, 'stdout'), pump(process.stderr, 'stderr')]), stopped,
    ]);
    result.exitCode = exitCode;
    return controller.respond(result);
  } catch {
    if (reason === 'timed_out' || reason === 'output_limit') {
      result.timedOut = reason === 'timed_out';
      result.outputTruncated = reason === 'output_limit';
      return controller.respond(result);
    }
    return controller.respond({ error: reason === 'container_not_running' ? reason : 'execution_unavailable' }, reason === 'container_not_running' ? 409 : 503);
  } finally {
    timers.clearTimeout(timer);
    request.signal.removeEventListener('abort', disconnected);
    active.delete(session);
    abort.abort();
    try { process?.kill(9); } catch { /* already exited */ }
    for (const reader of readers) void reader.cancel().catch(() => {});
  }
}

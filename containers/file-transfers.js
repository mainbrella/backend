import { MAX_EXECUTIONS } from './command-contract.js';
import { readFileBytes } from './file-contract.js';
import { exactByteStream, fixedByteStream, MAX_TRANSFER_BYTES, TRANSFER_TIMEOUT_MS, transferSize, validTransferPath } from './file-transfer-contract.js';
import { startOperationProcess, finishOperationProcess } from './process-supervisor.js';

const readScript = `
  [ -e "$1" ] || exit 44
  [ -f "$1" ] || exit 45
  [ -r "$1" ] || exit 46
  exec 3< "$1" || exit 46
  size=$(stat -Lc '%s' /proc/self/fd/3) || exit 46
  [ "$size" -le ${MAX_TRANSFER_BYTES} ] || exit 48
  printf '%s\\n' "$size"
  head -c "$size" <&3 || exit 46
`;
const writeScript = `
  [ ! -L "$1" ] || exit 45
  if [ -e "$1" ] && [ ! -f "$1" ]; then exit 45; fi
  parent=\${1%/*}; [ -n "$parent" ] || parent=/
  [ -d "$parent" ] || exit 44
  tmp=$(mktemp "$parent/.mainbrella-transfer.XXXXXXXXXX") || exit 46
  trap 'rm -f -- "$tmp"' EXIT HUP INT TERM
  head -c "$2" > "$tmp" || exit 46
  [ "$(wc -c < "$tmp")" -eq "$2" ] || exit 47
  IFS= read -r commit || exit 47
  [ "$commit" = "$3" ] || exit 47
  [ ! -L "$1" ] || exit 45
  if [ -e "$1" ] && [ ! -f "$1" ]; then exit 45; fi
  if [ -f "$1" ]; then chmod --reference="$1" -- "$tmp" || exit 46; fi
  mv -fT -- "$tmp" "$1" || exit 46
`;
const failures = { 44: ['file_not_found', 404], 45: ['not_regular_file', 409],
  46: ['file_access_denied', 403], 47: ['file_size_mismatch', 400], 48: ['file_too_large', 413] };

export async function transferFile(controller, request, active, timers = globalThis) {
  if (!['GET', 'PUT'].includes(request.method)) return controller.respond({ error: 'method_not_allowed' }, 405);
  const params = new URL(request.url).searchParams, path = params.get('path');
  const size = request.method === 'PUT' ? transferSize(params.get('size')) : null;
  if (!validTransferPath(path) || request.method === 'PUT' && size === null) return controller.respond({ error: 'invalid_request' }, 400);
  const createdAt = request.headers.get('x-exec-created-at'), expiry = request.headers.get('x-exec-expires-at');
  const expiresAt = expiry && /^\d+$/.test(expiry) ? Number(expiry) : NaN;
  if (!createdAt || !Number.isSafeInteger(expiresAt)) return controller.respond({ error: 'forbidden' }, 403);
  const metadata = await controller.getTerminalMetadata(createdAt, expiresAt);
  if (!metadata) return controller.respond({ error: 'container_not_running' }, 409);
  if (active.size >= MAX_EXECUTIONS) return controller.respond({ error: 'execution_limit' }, 429);

  const abort = new AbortController();
  let process, starting, reader, output, timer, exited = false, handedOff = false, reason, cleanup;
  let rejectStopped;
  const stopped = new Promise((_, reject) => { rejectStopped = reject; });
  void stopped.catch(() => {});
  const finish = () => cleanup ??= (async () => {
    timers.clearTimeout(timer);
    request.signal.removeEventListener('abort', disconnected);
    if (!exited) { abort.abort(); try { process?.kill(9); } catch {} }
    try { await reader?.cancel(); } catch {}
    try { reader?.releaseLock(); } catch {}
    process ??= starting?.operationProcess;
    await finishOperationProcess(controller, createdAt, process, active, session);
  })();
  const stop = value => {
    if (reason || cleanup) return;
    reason = value; abort.abort();
    try { process?.kill(9); } catch {}
    rejectStopped(new Error(value));
    if (output) { try { output.error(new Error(value)); } catch {} void finish(); }
  };
  const disconnected = () => stop('request_aborted');
  const session = { close: () => { stop('container_not_running'); return finish(); } };
  active.add(session);
  request.signal.addEventListener('abort', disconnected, { once: true });
  const timeout = Math.max(0, Math.min(TRANSFER_TIMEOUT_MS, metadata.expiresAt - controller.now()));
  timer = timers.setTimeout(() => stop('files_unavailable'), timeout);
  try {
    if (request.signal.aborted) disconnected();
    const commit = crypto.randomUUID();
    starting = startOperationProcess(controller, createdAt, expiresAt,
      ['/bin/sh', '-c', request.method === 'GET' ? readScript : writeScript, 'mainbrella-transfer', path, String(size ?? ''), commit],
      { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', signal: abort.signal }, timeout, metadata.telemetryId);
    void starting.then(value => { if (reason) { try { value.kill(9); } catch {} } }).catch(() => {});
    process = await Promise.race([starting, stopped]);
    const exit = process.exitCode.then(code => { exited = true; return code; });
    if (!await controller.touchTerminalActivity(createdAt)) throw new Error('container_not_running');
    if (!process.stdin || !process.stdout || !process.stderr) throw new Error('missing_stream');
    const stderr = readFileBytes(process.stderr, 8192, abort.signal);
    void stderr.catch(() => stop('files_unavailable'));
    if (request.method === 'PUT') {
      const send = (async () => {
        const input = exactByteStream(request.body, size, abort.signal).getReader(), writer = process.stdin.getWriter();
        try {
          while (true) { const { done, value } = await input.read(); if (done) break; await writer.write(value); }
          // Only a clean, exact-length EOF authorizes the guest's rename. Closing
          // a broken pipe alone can never commit a prefix of an aborted upload.
          if (abort.signal.aborted) throw new Error('request_aborted');
          await writer.write(new TextEncoder().encode(`${commit}\n`));
          await writer.close();
        } catch (error) { await writer.abort().catch(() => {}); throw error; }
        finally { await input.cancel().catch(() => {}); input.releaseLock(); writer.releaseLock(); }
      })();
      // A premature pipe close must not hide the guest's useful error status.
      let inputError;
      const [code] = await Promise.race([Promise.all([exit, stderr,
        readFileBytes(process.stdout, 1024, abort.signal), send.catch(error => { inputError = error; })]), stopped]);
      if (failures[code]) { const [error, status] = failures[code]; return controller.respond({ error }, status); }
      if (inputError?.message === 'file_size_mismatch') return controller.respond({ error: 'file_size_mismatch' }, 400);
      if (code !== 0 || inputError) throw new Error('files_unavailable');
      return controller.respond({ path, size });
    }
    await process.stdin.close();
    reader = process.stdout.getReader();
    let header = '', pending;
    while (true) {
      const { done, value } = await Promise.race([reader.read(), stopped]);
      if (done) {
        const code = await Promise.race([exit, stopped]);
        if (failures[code]) { const [error, status] = failures[code]; return controller.respond({ error }, status); }
        throw new Error('files_unavailable');
      }
      const newline = value.indexOf(10), prefix = newline < 0 ? value : value.subarray(0, newline);
      if (header.length + prefix.byteLength > 16) throw new Error('files_unavailable');
      header += new TextDecoder('utf-8', { fatal: true }).decode(prefix);
      if (newline >= 0) { pending = value.subarray(newline + 1); break; }
    }
    const length = transferSize(header);
    if (length === null) throw new Error('files_unavailable');
    let received = 0;
    const stream = new ReadableStream({
      start(value) { output = value; },
      async pull(value) {
        try {
          if (reason) throw new Error(reason);
          const next = pending?.byteLength ? { value: pending, done: false } : await Promise.race([reader.read(), stopped]);
          pending = undefined;
          if (next.done) {
            const [code] = await Promise.race([Promise.all([exit, stderr]), stopped]);
            if (code !== 0 || received !== length) throw new Error('files_unavailable');
            await finish(); value.close(); return;
          }
          received += next.value.byteLength;
          if (received > length) throw new Error('files_unavailable');
          value.enqueue(next.value);
        } catch { try { value.error(new Error('files_unavailable')); } catch {} await finish(); }
      },
      async cancel() { stop('request_aborted'); await finish(); },
    }, { highWaterMark: 0 });
    handedOff = true;
    return new Response(fixedByteStream(stream, length, abort.signal), { headers: { 'content-type': 'application/octet-stream', 'content-length': String(length), 'cache-control': 'no-store' } });
  } catch (error) {
    process ??= error.operationProcess ?? starting?.operationProcess;
    const unavailable = reason === 'container_not_running' || error.message === 'container_not_running' || error.message === 'Machine unavailable';
    return controller.respond({ error: unavailable ? 'container_not_running' : 'files_unavailable' }, unavailable ? 409 : 503);
  } finally { if (!handedOff) await finish(); }
}

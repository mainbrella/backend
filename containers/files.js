import { MAX_EXECUTIONS } from './command-contract.js';
import { FILE_TIMEOUT_MS, MAX_FILE_BYTES, readFileBytes, validFilePath } from './file-contract.js';
import { startOperationProcess } from './process-supervisor.js';

// Paths are positional arguments, never interpolated shell code. Reads follow
// symlinks inside the owned guest; writes replace regular files and reject links.
const readScript = `
  [ -e "$1" ] || exit 44
  [ -f "$1" ] || exit 45
  [ -r "$1" ] || exit 46
  head -c ${MAX_FILE_BYTES + 1} -- "$1"
`;
const writeScript = `
  [ ! -L "$1" ] || exit 45
  if [ -e "$1" ] && [ ! -f "$1" ]; then exit 45; fi
  parent=\${1%/*}; [ -n "$parent" ] || parent=/
  [ -d "$parent" ] || exit 44
  tmp=$(mktemp "$parent/.mainbrella-file.XXXXXXXXXX") || exit 46
  trap 'rm -f -- "$tmp"' EXIT HUP INT TERM
  cat > "$tmp" || exit 46
  if [ -f "$1" ]; then chmod --reference="$1" -- "$tmp" || exit 46; fi
  mv -fT -- "$tmp" "$1" || exit 46
`;

export async function accessFile(controller, request, active, timers = globalThis) {
  if (!['GET', 'PUT'].includes(request.method)) return controller.respond({ error: 'method_not_allowed' }, 405);
  const path = new URL(request.url).searchParams.get('path');
  if (!validFilePath(path)) return controller.respond({ error: 'invalid_file_path' }, 400);
  const createdAt = request.headers.get('x-exec-created-at');
  const expiryText = request.headers.get('x-exec-expires-at');
  const expiresAt = expiryText && /^\d+$/.test(expiryText) ? Number(expiryText) : NaN;
  if (!createdAt || !Number.isSafeInteger(expiresAt)) return controller.respond({ error: 'forbidden' }, 403);
  let input;
  try { input = request.method === 'PUT' ? await readFileBytes(request.body, MAX_FILE_BYTES, request.signal) : new Uint8Array(); }
  catch (error) { return controller.respond({ error: error.message === 'file_too_large' ? 'file_too_large' : 'invalid_request' }, error.message === 'file_too_large' ? 413 : 400); }
  const metadata = await controller.getTerminalMetadata(createdAt, expiresAt);
  if (!metadata) return controller.respond({ error: 'container_not_running' }, 409);
  // File operations share the command pool and are closed when the machine stops.
  if (active.size >= MAX_EXECUTIONS) return controller.respond({ error: 'execution_limit' }, 429);

  const abort = new AbortController();
  let process;
  let exited = false;
  let reason;
  let rejectStopped;
  const stopped = new Promise((_, reject) => { rejectStopped = reject; });
  void stopped.catch(() => {});
  const stop = value => {
    if (reason) return;
    reason = value;
    if (!exited) {
      abort.abort();
    }
    try { process?.kill(9); } catch { /* already exited */ }
    rejectStopped(new Error(value));
  };
  const session = { close: () => stop('container_not_running') };
  active.add(session);
  const disconnected = () => stop('files_unavailable');
  request.signal.addEventListener('abort', disconnected, { once: true });
  const timer = timers.setTimeout(() => stop('files_unavailable'), Math.max(0,
    Math.min(FILE_TIMEOUT_MS, metadata.expiresAt - controller.now())));
  let writer;
  try {
    if (request.signal.aborted) disconnected();
    const starting = startOperationProcess(controller, createdAt, expiresAt,
      ['/bin/sh', '-c', request.method === 'GET' ? readScript : writeScript, 'mainbrella-files', path],
      { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', signal: abort.signal }, Math.min(FILE_TIMEOUT_MS, metadata.expiresAt - controller.now()));
    void starting.then(value => { if (reason) { try { value.kill(9); } catch {} } }).catch(() => {});
    process = await Promise.race([starting, stopped]);
    const exit = process.exitCode.then(code => { exited = true; return code; });
    if (!await controller.touchTerminalActivity(createdAt)) throw new Error('Machine unavailable');
    if (!process.stdin || !process.stdout || !process.stderr) throw new Error('missing_stream');
    writer = process.stdin.getWriter();
    const send = async () => {
      if (input.byteLength) await writer.write(input);
      await writer.close();
    };
    // Consume both output streams during the write so no pipe can deadlock.
    let inputFailed = false;
    const [exitCode, bytes] = await Promise.race([Promise.all([
      exit, readFileBytes(process.stdout, MAX_FILE_BYTES + 1, abort.signal),
      readFileBytes(process.stderr, 8192, abort.signal), send().catch(() => { inputFailed = true; }),
    ]), stopped]);
    const failures = { 44: ['file_not_found', 404], 45: ['not_regular_file', 409], 46: ['file_access_denied', 403] };
    if (failures[exitCode]) {
      const [error, status] = failures[exitCode];
      return controller.respond({ error }, status);
    }
    if (exitCode !== 0 || inputFailed) throw new Error('file_process_failed');
    if (bytes.byteLength > MAX_FILE_BYTES) return controller.respond({ error: 'file_too_large' }, 413);
    if (request.method === 'PUT') return controller.respond({ path, size: input.byteLength });
    return new Response(bytes, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' } });
  } catch (error) {
    const unavailable = reason === 'container_not_running' || error.message === 'Machine unavailable';
    return controller.respond({ error: unavailable ? 'container_not_running' : 'files_unavailable' }, unavailable ? 409 : 503);
  } finally {
    timers.clearTimeout(timer);
    request.signal.removeEventListener('abort', disconnected);
    active.delete(session);
    if (!exited) {
      abort.abort();
      try { process?.kill(9); } catch { /* already exited */ }
    }
    if (writer) void writer.abort().catch(() => {});
    await process?.dispose?.();
  }
}

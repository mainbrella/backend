import { MAX_EXECUTIONS } from './command-contract.js';
import { FILE_TIMEOUT_MS, readFileBytes } from './file-contract.js';
import { startOperationProcess } from './process-supervisor.js';
import { DEFAULT_DIRECTORY_ENTRIES, MAX_DIRECTORY_OFFSET, MAX_FILESYSTEM_OUTPUT_BYTES, decodeFilesystemEntries,
  readFilesystemBody, validFilesystemOperation } from './filesystem-contract.js';

// The script is fixed; all customer values are positional arguments. NUL-delimited
// output preserves spaces, shell characters and newlines. Paths address the owned
// guest filesystem; intermediate symlinks may resolve inside that guest.
const script = String.raw`
set -o pipefail
export LC_ALL=C
operation=$1; path=$2
exists() { [ -e "$1" ] || [ -L "$1" ]; }
entry() {
  printf '%s\0' "$2"
  if [ "$3" = true ]; then stat -L --printf='%f\0%s\0%u\0%g\0%Y\0' -- "$1" || return 46
  else stat --printf='%f\0%s\0%u\0%g\0%Y\0' -- "$1" || return 46; fi
  if [ "$3" != true ] && [ -L "$1" ]; then readlink -z -- "$1" || return 46
  else printf '\0'; fi
}
case "$operation" in
  stat)
    exists "$path" || exit 44
    if [ "$3" = true ] && [ ! -e "$path" ]; then exit 44; fi
    entry "$path" "$path" "$3" || exit "$?"
    ;;
  list)
    exists "$path" || exit 44
    [ -d "$path" ] || exit 45
    [ -r "$path" ] && [ -x "$path" ] || exit 46
    # Materialize only the requested page's names. Sorting can use disk and is
    # bounded by the operation deadline; pagination is a rescan, not a snapshot.
    page=$(mktemp) || exit 46
    trap 'rm -f -- "$page"' EXIT HUP INT TERM
    find -H "$path" -mindepth 1 -maxdepth 1 -printf '%f\0' | sort -z | sed -z -n "$(( $4 + 1 )),$(( $4 + $3 + 1 ))p" > "$page" || exit 46
    while IFS= read -r -d '' name; do
      entry "$path/$name" "$name" false || exit "$?"
    done < "$page"
    ;;
  mkdir)
    exists "$path" && { [ "$3" = true ] && [ -d "$path" ] && [ ! -L "$path" ] && exit 0; exit 47; }
    parent=$(dirname -- "$path")
    if [ "$3" != true ] && [ ! -d "$parent" ]; then exit 44; fi
    if [ "$3" = true ]; then mkdir -p -m "$4" -- "$path" || exit 46
    else mkdir -m "$4" -- "$path" || exit 46; fi
    ;;
  remove)
    exists "$path" || exit 44
    if [ -d "$path" ] && [ ! -L "$path" ]; then
      if [ "$3" = true ]; then rm -r -- "$path" || exit 46
      else rmdir -- "$path" 2>/dev/null || {
        contents=$(find -H "$path" -mindepth 1 -maxdepth 1 -printf x -quit 2>/dev/null) || exit 46
        [ -n "$contents" ] && [ -w "$(dirname -- "$path")" ] && exit 48
        exit 46
      }; fi
    else rm -- "$path" || exit 46; fi
    ;;
  move)
    exists "$path" || exit 44
    exists "$3" && exit 47
    parent=$(dirname -- "$3")
    [ -d "$parent" ] || exit 44
    # -n prevents replacement during a destination race; -T keeps destination
    # semantics exact if a directory appears. Never silently nest or overwrite.
    mv -nT -- "$path" "$3" || exit 46
    exists "$path" && exit 47
    ;;
  chmod)
    exists "$path" || exit 44
    [ ! -L "$path" ] || exit 49
    chmod "0$3" -- "$path" || exit 46
    ;;
  *) exit 50;;
esac
exit 0
`;

export async function accessFilesystem(controller, request, active, timers = globalThis) {
  if (request.method !== 'POST') return controller.respond({ error: 'method_not_allowed' }, 405);
  const operation = new URL(request.url).pathname.split('/').at(-1);
  let body;
  try { body = await readFilesystemBody(request); } catch { return controller.respond({ error: 'invalid_request' }, 400); }
  if (!validFilesystemOperation(operation, body)) return controller.respond({ error: 'invalid_request' }, 400);
  const createdAt = request.headers.get('x-exec-created-at');
  const expiry = request.headers.get('x-exec-expires-at');
  const expiresAt = expiry && /^\d+$/.test(expiry) ? Number(expiry) : NaN;
  if (!createdAt || !Number.isSafeInteger(expiresAt)) return controller.respond({ error: 'forbidden' }, 403);
  const metadata = await controller.getTerminalMetadata(createdAt, expiresAt);
  if (!metadata) return controller.respond({ error: 'container_not_running' }, 409);
  if (active.size >= MAX_EXECUTIONS) return controller.respond({ error: 'execution_limit' }, 429);
  const options = operation === 'list' ? [String(body.limit ?? DEFAULT_DIRECTORY_ENTRIES), String(body.offset ?? 0)]
    : operation === 'stat' ? [String(body.followSymlinks ?? false)]
    : operation === 'mkdir' ? [String(body.recursive ?? false), body.mode ?? '0700']
    : operation === 'remove' ? [String(body.recursive ?? false)] : operation === 'move' ? [body.destination] : [body.mode];
  const argv = ['/bin/bash', '-c', script, 'mainbrella-filesystem', operation, body.path, ...options];
  const abort = new AbortController();
  let process, reason, exited = false, rejectStopped;
  const stopped = new Promise((_, reject) => { rejectStopped = reject; });
  void stopped.catch(() => {});
  const stop = value => {
    if (reason) return;
    reason = value;
    if (!exited) abort.abort();
    try { process?.kill(9); } catch {}
    rejectStopped(new Error(value));
  };
  const session = { close: () => stop('container_not_running') };
  active.add(session);
  const disconnected = () => stop('files_unavailable');
  request.signal.addEventListener('abort', disconnected, { once: true });
  const timer = timers.setTimeout(() => stop('files_unavailable'), Math.max(0, Math.min(FILE_TIMEOUT_MS, metadata.expiresAt - controller.now())));
  try {
    if (request.signal.aborted) disconnected();
    const starting = startOperationProcess(controller, createdAt, expiresAt, argv, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', signal: abort.signal },
      Math.min(FILE_TIMEOUT_MS, metadata.expiresAt - controller.now()));
    void starting.then(value => { if (reason) { try { value.kill(9); } catch {} } }).catch(() => {});
    process = await Promise.race([starting, stopped]);
    const exit = process.exitCode.then(code => { exited = true; return code; });
    if (!await controller.touchTerminalActivity(createdAt)) throw new Error('Machine unavailable');
    if (!process.stdin || !process.stdout || !process.stderr) throw new Error('missing_stream');
    const [exitCode, bytes] = await Promise.race([Promise.all([exit,
      readFileBytes(process.stdout, MAX_FILESYSTEM_OUTPUT_BYTES + 1, abort.signal), readFileBytes(process.stderr, 8192, abort.signal), process.stdin.close()]), stopped]);
    const failures = { 44: ['file_not_found', 404], 45: ['not_directory', 409], 46: ['file_access_denied', 403],
      47: ['file_exists', 409], 48: ['directory_not_empty', 409], 49: ['symlink_not_allowed', 409], 50: ['invalid_request', 400] };
    if (failures[exitCode]) { const [error, status] = failures[exitCode]; return controller.respond({ error }, status); }
    if (exitCode !== 0) throw new Error('files_unavailable');
    if (bytes.byteLength > MAX_FILESYSTEM_OUTPUT_BYTES) return controller.respond({ error: 'directory_too_large' }, 413);
    if (operation === 'stat') {
      const entries = decodeFilesystemEntries(bytes);
      if (entries.length !== 1 || entries[0].path !== body.path) throw new Error('files_unavailable');
      return controller.respond(entries[0]);
    }
    if (operation === 'list') {
      const entries = decodeFilesystemEntries(bytes, body.path);
      const limit = body.limit ?? DEFAULT_DIRECTORY_ENTRIES, offset = body.offset ?? 0;
      if (entries.length > limit + 1) throw new Error('files_unavailable');
      if (entries.length > limit && offset + limit > MAX_DIRECTORY_OFFSET) return controller.respond({ error: 'directory_too_large' }, 413);
      return controller.respond({ path: body.path, entries: entries.slice(0, limit), nextOffset: entries.length > limit ? offset + limit : null });
    }
    return controller.respond({ path: body.path, ...(operation === 'move' ? { destination: body.destination } : {}), ...(operation === 'chmod' ? { mode: body.mode } : {}), ok: true });
  } catch (error) {
    const unavailable = reason === 'container_not_running' || error.message === 'Machine unavailable';
    if (error.message === 'unsupported_file_name') return controller.respond({ error: error.message }, 409);
    if (error.message === 'file_too_large') return controller.respond({ error: 'directory_too_large' }, 413);
    return controller.respond({ error: unavailable ? 'container_not_running' : 'files_unavailable' }, unavailable ? 409 : 503);
  } finally {
    timers.clearTimeout(timer); request.signal.removeEventListener('abort', disconnected); active.delete(session);
    if (!exited) { abort.abort(); try { process?.kill(9); } catch {} }
    await process?.dispose?.();
  }
}

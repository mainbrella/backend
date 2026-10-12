// Native Linux notifications. This source is also packaged in Python's _watch_guest.py.
export const NATIVE_WATCH_GUEST = String.raw`
const { watch, lstatSync } = require('node:fs');
const path = process.argv[1], recursive = process.argv[2] === 'true';
let watcher, total = 0, stopped = false;
function stop(code) {
  if (stopped) return;
  stopped = true;
  watcher?.close();
  if (code) process.stdout.write(JSON.stringify({ type: 'error', code }) + '\n');
  process.exitCode = code ? 1 : 0;
}
function emit(value) {
  if (stopped) return;
  const line = JSON.stringify(value) + '\n';
  total += Buffer.byteLength(line);
  if (Buffer.byteLength(line) > 16384 || total > 524288) return stop('file_watch_output_limit');
  process.stdout.write(line);
}
try {
  if (process.platform !== 'linux' || Number(process.versions.node.split('.')[0]) < 22) throw Error();
  if (!lstatSync(path).isDirectory()) throw Error();
  watcher = watch(path, { recursive, encoding: 'buffer' }, (type, raw) => {
    try {
      const filename = raw === null ? null : new TextDecoder('utf-8', { fatal: true }).decode(raw);
      if (filename !== null && (!filename || filename.startsWith('/') || filename.includes('\0') || filename.split('/').some(p => !p || p === '.' || p === '..'))) throw Error();
      emit({ type, filename });
    } catch { stop('file_watch_filename_invalid'); }
  });
  watcher.on('error', () => stop('file_watch_unavailable'));
  watcher.on('close', () => { stopped = true; });
  process.once('SIGTERM', () => stop());
  process.once('SIGINT', () => stop());
  emit({ type: 'ready', path, recursive });
} catch { stop('file_watch_unavailable'); }
`;

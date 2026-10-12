// Native Linux notifications. This source is also packaged in Python's _watch_guest.py.
export const NATIVE_WATCH_GUEST = String.raw`
const { watch, lstatSync, readdirSync } = require('node:fs');
const { join, relative } = require('node:path');
const path = process.argv[1], recursive = process.argv[2] === 'true';
const watchers = new Map();
let total = 0, stopped = false;
function stop(code) {
  if (stopped) return;
  stopped = true;
  for (const watcher of watchers.values()) watcher.close();
  watchers.clear();
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
function filename(raw) {
  if (raw === null) return null;
  const value = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  if (!value || value.includes('/') || value.includes('\0') || value === '.' || value === '..') throw Error();
  return value;
}
function removeTree(directory) {
  for (const [name, watcher] of watchers) if (name === directory || name.startsWith(directory + '/')) {
    watchers.delete(name); watcher.close();
  }
}
function addTree(directory, depth = 0) {
  if (stopped || watchers.has(directory)) return;
  if (depth > 64 || watchers.size >= 2048) return stop('file_watch_directory_limit');
  if (!lstatSync(directory).isDirectory()) return;
  const watcher = watch(directory, { encoding: 'buffer' }, (type, raw) => {
    try {
      const name = filename(raw);
      const target = name === null ? null : join(directory, name);
      const relativeName = target === null ? null : relative(path, target);
      if (relativeName !== null && Buffer.byteLength(relativeName) > 4096) throw Error();
      emit({ type, filename: relativeName });
      if (recursive && type === 'rename' && target !== null) {
        removeTree(target);
        try { addTree(target, relative(path, target).split('/').length); }
        catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) stop('file_watch_unavailable'); }
      }
    } catch { stop('file_watch_filename_invalid'); }
  });
  watchers.set(directory, watcher);
  watcher.on('error', () => stop('file_watch_unavailable'));
  watcher.on('close', () => { if (watchers.get(directory) === watcher) watchers.delete(directory); });
  if (recursive) for (const entry of readdirSync(directory, { withFileTypes: true, encoding: 'buffer' })) {
    if (entry.isDirectory()) addTree(join(directory, filename(entry.name)), depth + 1);
  }
}
try {
  if (process.platform !== 'linux' || Number(process.versions.node.split('.')[0]) < 22) throw Error();
  if (!lstatSync(path).isDirectory()) throw Error();
  addTree(path);
  process.once('SIGTERM', () => stop());
  process.once('SIGINT', () => stop());
  emit({ type: 'ready', path, recursive });
} catch { stop('file_watch_unavailable'); }
`;

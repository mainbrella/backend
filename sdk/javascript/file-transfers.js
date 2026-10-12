import { watchNative } from './file-watch.js';

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 10_000;

function remotePath(value, ErrorType) {
  if (typeof value !== 'string' || !value.startsWith('/') || value === '/' || value.includes('\0')
    || value.split('/').slice(1).some(part => !part || part === '.' || part === '..')) throw new ErrorType('invalid_file_path');
  return value;
}
function childPath(parent, entry, ErrorType) {
  if (typeof entry.name !== 'string' || !entry.name || /[/\\\0]/.test(entry.name) || ['.', '..'].includes(entry.name)) throw new ErrorType('invalid_directory_entry');
  return `${parent}/${entry.name}`;
}

export function fileTransfers(sandbox, ErrorType) {
  const upload = (path, source, { size = source instanceof Uint8Array ? source.byteLength : undefined, signal } = {}) => {
    remotePath(path, ErrorType);
    if (!(source instanceof Uint8Array) && !(source instanceof ReadableStream)) throw new ErrorType('file_stream_required');
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BYTES || source instanceof Uint8Array && source.byteLength !== size) throw new ErrorType('invalid_transfer_size');
    return sandbox.client.request(sandbox.path('/containers/files/transfer', { path, size: String(size) }), { method: 'PUT', body: source, signal });
  };
  const download = async (path, { signal } = {}) => {
    remotePath(path, ErrorType);
    const response = await sandbox.client.request(sandbox.path('/containers/files/transfer', { path }), { stream: true, signal });
    const size = Number(response.headers.get('content-length'));
    if (!response.body || !response.headers.has('content-length') || !Number.isSafeInteger(size) || size < 0 || size > MAX_BYTES) {
      await response.body?.cancel(); throw new ErrorType('invalid_response');
    }
    let received = 0;
    return response.body.pipeThrough(new TransformStream({
      transform(bytes, controller) { received += bytes.byteLength; if (received > size) throw new ErrorType('file_size_mismatch'); controller.enqueue(bytes); },
      flush() { if (received !== size) throw new ErrorType('file_size_mismatch'); },
    }), { signal });
  };
  async function* entries(path, signal) {
    let offset;
    do {
      signal?.throwIfAborted();
      const page = await sandbox.client.request(sandbox.path('/containers/files/list', { path, limit: '1000', ...(offset !== undefined ? { offset: String(offset) } : {}) }), { signal });
      for (const entry of page.entries) { childPath(path, entry, ErrorType); yield entry; }
      if (page.nextOffset !== null && (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= (offset ?? 0))) throw new ErrorType('invalid_response');
      offset = page.nextOffset;
    } while (offset !== null);
  }
  async function snapshot(path, recursive, signal) {
    const found = new Map();
    const walk = async (directory, depth) => {
      if (depth > 64) throw new ErrorType('directory_too_large');
      for await (const entry of entries(directory, signal)) {
        const child = childPath(directory, entry, ErrorType);
        if (found.size >= MAX_ENTRIES) throw new ErrorType('directory_too_large');
        found.set(child, { ...entry, path: child });
        if (recursive && entry.type === 'directory') await walk(child, depth + 1);
      }
    };
    await walk(path, 0); return found;
  }
  return {
    upload, download,
    watchNative(path, options) { remotePath(path, ErrorType); return watchNative(sandbox, path, options, ErrorType); },
    async uploadDirectory(local, remote, { signal } = {}) {
      remotePath(remote, ErrorType);
      const fs = await import('node:fs/promises'), { Readable } = await import('node:stream'), { join } = await import('node:path');
      let count = 0;
      const walk = async (source, destination, depth) => {
        signal?.throwIfAborted();
        if (depth > 64 || ++count > MAX_ENTRIES) throw new ErrorType('directory_too_large');
        const info = await fs.lstat(source);
        if (info.isSymbolicLink()) throw new ErrorType('symlink_not_allowed');
        if (info.isDirectory()) {
          await sandbox.files.mkdir(destination, { recursive: true });
          for (const name of await fs.readdir(source)) await walk(join(source, name), childPath(destination, { name }, ErrorType), depth + 1);
        } else if (info.isFile()) {
          const handle = await fs.open(source, 'r');
          try { await upload(destination, Readable.toWeb(handle.createReadStream()), { size: info.size, signal }); }
          finally { await handle.close(); }
        } else throw new ErrorType('not_regular_file');
      };
      if (!(await fs.lstat(local)).isDirectory()) throw new ErrorType('not_directory');
      await walk(local, remote, 0); return { entries: count };
    },
    async downloadDirectory(remote, local, { signal } = {}) {
      remotePath(remote, ErrorType);
      const fs = await import('node:fs/promises'), { Writable } = await import('node:stream'), { join } = await import('node:path');
      const files = await snapshot(remote, true, signal);
      if ([...files.values()].some(entry => !['file', 'directory'].includes(entry.type))) throw new ErrorType('not_regular_file');
      await fs.mkdir(local, { recursive: true });
      if ((await fs.lstat(local)).isSymbolicLink()) throw new ErrorType('symlink_not_allowed');
      const root = await fs.realpath(local);
      for (const [path, entry] of files) {
        signal?.throwIfAborted();
        const destination = join(root, ...path.slice(remote.length + 1).split('/'));
        let existing;
        try { existing = await fs.lstat(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (existing?.isSymbolicLink()) throw new ErrorType('symlink_not_allowed');
        if (entry.type === 'directory') { await fs.mkdir(destination, { recursive: true }); continue; }
        if (existing && !existing.isFile()) throw new ErrorType('not_regular_file');
        const staging = await fs.mkdtemp(join(root, '.mainbrella-download-'));
        try {
          const handle = await fs.open(join(staging, 'file'), 'wx', 0o600);
          try { await (await download(path, { signal })).pipeTo(Writable.toWeb(handle.createWriteStream()), { signal }); }
          finally { await handle.close(); }
          await fs.rename(join(staging, 'file'), destination);
        } finally { await fs.rm(staging, { recursive: true, force: true }); }
      }
      return { entries: files.size };
    },
    async *watch(path, { intervalMs = 1000, recursive = true, signal } = {}) {
      remotePath(path, ErrorType);
      if (!Number.isInteger(intervalMs) || intervalMs < 250 || typeof recursive !== 'boolean') throw new ErrorType('invalid_file_options');
      let previous = await snapshot(path, recursive, signal);
      while (true) {
        await new Promise((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(signal.reason); };
          const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, intervalMs);
          signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
        });
        const current = await snapshot(path, recursive, signal);
        for (const [key, entry] of current) {
          const before = previous.get(key);
          if (!before) yield { type: 'create', entry };
          else if (JSON.stringify(before) !== JSON.stringify(entry)) yield { type: 'modify', entry };
        }
        for (const [key, entry] of previous) if (!current.has(key)) yield { type: 'remove', entry };
        previous = current;
      }
    },
  };
}

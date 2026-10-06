import { readFileBytes, validFilePath } from './file-contract.js';

export const MAX_DIRECTORY_ENTRIES = 1000;
export const DEFAULT_DIRECTORY_ENTRIES = 100;
export const MAX_DIRECTORY_OFFSET = 1_000_000;
export const MAX_FILESYSTEM_OUTPUT_BYTES = 1024 * 1024;
export const MAX_FILESYSTEM_BODY_BYTES = 16 * 1024;
export const FILESYSTEM_OPERATIONS = ['list', 'stat', 'mkdir', 'remove', 'move', 'chmod'];

export function validFilesystemPath(path, allowRoot = false) {
  return typeof path === 'string' && (allowRoot && path === '/' || validFilePath(path))
    && new TextDecoder().decode(new TextEncoder().encode(path)) === path;
}

export function validFilesystemOperation(operation, value) {
  if (!FILESYSTEM_OPERATIONS.includes(operation) || !value || typeof value !== 'object' || Array.isArray(value)) return false;
  const allowed = { list: ['path', 'limit', 'offset'], stat: ['path', 'followSymlinks'], mkdir: ['path', 'recursive', 'mode'],
    remove: ['path', 'recursive'], move: ['path', 'destination'], chmod: ['path', 'mode'] }[operation];
  if (Object.keys(value).some(key => !allowed.includes(key)) || !validFilesystemPath(value.path, ['list', 'stat'].includes(operation))) return false;
  if (value.recursive !== undefined && typeof value.recursive !== 'boolean'
    || value.followSymlinks !== undefined && typeof value.followSymlinks !== 'boolean') return false;
  if (value.mode !== undefined && (typeof value.mode !== 'string' || !/^0[0-7]{3}$/.test(value.mode))) return false;
  if (operation === 'chmod' && value.mode === undefined) return false;
  if (operation === 'move' && (!validFilesystemPath(value.destination) || value.destination === value.path
    || value.destination.startsWith(`${value.path}/`))) return false;
  if (operation === 'list' && (value.limit !== undefined && (!Number.isInteger(value.limit) || value.limit < 1 || value.limit > MAX_DIRECTORY_ENTRIES)
    || value.offset !== undefined && (!Number.isInteger(value.offset) || value.offset < 0 || value.offset > MAX_DIRECTORY_OFFSET))) return false;
  return true;
}

export async function readFilesystemBody(request) {
  const bytes = await readFileBytes(request.body, MAX_FILESYSTEM_BODY_BYTES, request.signal);
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

// Public metadata uses lstat semantics unless explicit dereferencing is requested.
export function decodeFilesystemEntries(bytes, directory) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('unsupported_file_name'); }
  const fields = text.split('\0');
  if (fields.pop() !== '' || fields.length % 7) throw new Error('files_unavailable');
  const entries = [];
  for (let i = 0; i < fields.length; i += 7) {
    const [name, modeHex, sizeText, uidText, gidText, modifiedText, linkTarget] = fields.slice(i, i + 7);
    const path = directory === undefined ? name : `${directory === '/' ? '' : directory}/${name}`;
    if (!validFilesystemPath(path, true) || directory !== undefined && (!name || name.includes('/'))) throw new Error('unsupported_file_name');
    if (!/^[a-fA-F0-9]{1,8}$/.test(modeHex) || ![sizeText, uidText, gidText].every(v => /^\d+$/.test(v))
      || !/^-?\d+$/.test(modifiedText)) throw new Error('files_unavailable');
    const [mode, size, uid, gid, modified] = [parseInt(modeHex, 16), Number(sizeText), Number(uidText), Number(gidText), Number(modifiedText)];
    if (![size, uid, gid, modified].every(Number.isSafeInteger) || !Number.isFinite(new Date(modified * 1000).getTime())) throw new Error('files_unavailable');
    const kind = mode & 0o170000;
    const type = ({ [0o100000]: 'file', [0o040000]: 'directory', [0o120000]: 'symlink', [0o010000]: 'fifo',
      [0o140000]: 'socket', [0o020000]: 'character', [0o060000]: 'block' })[kind] || 'other';
    entries.push({ name: directory === undefined ? path.split('/').at(-1) || '/' : name, path, type, size, mode: (mode & 0o7777).toString(8).padStart(4, '0'),
      uid, gid, modifiedAt: new Date(modified * 1000).toISOString(), ...(type === 'symlink' ? { linkTarget } : {}) });
  }
  return entries;
}

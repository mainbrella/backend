export const MAX_DIRECTORY_ENTRIES: number;
export const DEFAULT_DIRECTORY_ENTRIES: number;
export const MAX_DIRECTORY_OFFSET: number;
export const MAX_FILESYSTEM_OUTPUT_BYTES: number;
export const MAX_FILESYSTEM_BODY_BYTES: number;
export const FILESYSTEM_OPERATIONS: string[];
export type FilesystemOperation = 'list' | 'stat' | 'mkdir' | 'remove' | 'move' | 'chmod';
export interface FilesystemOptions { path: string; limit?: number; offset?: number; followSymlinks?: boolean; recursive?: boolean; mode?: string; destination?: string }
export interface FileEntry { name: string; path: string; type: 'file' | 'directory' | 'symlink' | 'fifo' | 'socket' | 'character' | 'block' | 'other'; size: number; mode: string; uid: number; gid: number; modifiedAt: string; linkTarget?: string }
export function validFilesystemPath(path: unknown, allowRoot?: boolean): path is string;
export function validFilesystemOperation(operation: string, value: unknown): value is FilesystemOptions;
export function readFilesystemBody(request: Request): Promise<unknown>;
export function decodeFilesystemEntries(bytes: Uint8Array, directory?: string): FileEntry[];

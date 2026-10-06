import { z } from 'zod';
import { containerSecurity, errors, jsonResponse, register, requestBody, type LegacyHandler, type OpenAPIApi } from './openapi-shared';
import { DEFAULT_DIRECTORY_ENTRIES, MAX_DIRECTORY_ENTRIES, MAX_DIRECTORY_OFFSET, MAX_FILESYSTEM_OUTPUT_BYTES } from '../../containers/filesystem-contract.js';
import { FILE_TIMEOUT_MS, MAX_FILE_PATH_BYTES } from '../../containers/file-contract.js';

const path = z.string().min(1).max(MAX_FILE_PATH_BYTES).describe('Absolute UTF-8 guest path, at most 4096 bytes. No empty, dot or parent segments. Root is allowed only for list/stat.');
const mode = z.string().regex(/^0[0-7]{3}$/).describe('Octal permission bits, from 0000 through 0777.');
export const fileEntrySchema = z.object({ name: z.string(), path: z.string(),
  type: z.enum(['file', 'directory', 'symlink', 'fifo', 'socket', 'character', 'block', 'other']),
  size: z.number().int().nonnegative(), mode: z.string(), uid: z.number().int().nonnegative(), gid: z.number().int().nonnegative(),
  modifiedAt: z.iso.datetime(), linkTarget: z.string().optional(),
}).openapi('FileEntry');

export function registerFilesystemRoutes(api: OpenAPIApi, handler: LegacyHandler): void {
  const identity = { id: z.string(), createdAt: z.iso.datetime() };
  const headers = z.object({ Origin: z.string().optional().describe('Required for cookie mutations; Bearer keys may omit it.') });
  const common = { tags: ['Containers'], security: containerSecurity,
    description: `Owned, generation-qualified guest filesystem operation. Rechecks the generation and paid lease before launch, shares the four-operation execution pool and renews idle activity. Bounded by ${FILE_TIMEOUT_MS} ms and the hard deadline; output is at most ${MAX_FILESYSTEM_OUTPUT_BYTES} bytes. Requires bash, GNU coreutils, findutils and sed in the image. Intermediate symlinks resolve inside the owned guest. No start is consumed. Files are ephemeral. Mutations are never automatically retried; inspect state after a lost response.`,
  };
  const failures = errors(400, 401, 402, 403, 404, 409, 413, 429, 503);
  register(api, 'get', '/containers/files/list', { ...common, operationId: 'listContainerDirectory', summary: 'List a directory page',
    description: `${common.description} One level only, sorted by UTF-8 filename bytes. Child symlinks are not followed. The directory itself may be a symlink. Pagination rescans the directory; changes between pages can duplicate or omit entries. Non-UTF-8 filenames fail explicitly rather than returning an unusable replacement path.`,
    request: { query: z.object({ ...identity, path, limit: z.coerce.number().int().min(1).max(MAX_DIRECTORY_ENTRIES).default(DEFAULT_DIRECTORY_ENTRIES),
      offset: z.coerce.number().int().min(0).max(MAX_DIRECTORY_OFFSET).default(0) }), headers },
    responses: { 200: jsonResponse(z.object({ path: z.string(), entries: z.array(fileEntrySchema), nextOffset: z.number().int().nullable() })), ...failures },
  }, handler);
  register(api, 'get', '/containers/files/stat', { ...common, operationId: 'statContainerFile', summary: 'Read file metadata',
    description: `${common.description} Returns metadata for the symlink itself by default, including its target; followSymlinks=true reads the target instead. Broken symlinks can be inspected without dereferencing. Modification times have second precision.`,
    request: { query: z.object({ ...identity, path, followSymlinks: z.enum(['true', 'false']).optional() }), headers },
    responses: { 200: jsonResponse(fileEntrySchema), ...failures },
  }, handler);
  register(api, 'post', '/containers/files/mkdir', { ...common, operationId: 'createContainerDirectory', summary: 'Create a directory',
    description: `${common.description} recursive=true creates missing parents; existing non-symlink directories succeed. Default permissions are 0700 for the final directory. Parent permissions follow the guest umask. Existing leaf symlinks and non-directories conflict.`,
    request: { query: z.object(identity), headers, ...requestBody(z.object({ path, recursive: z.boolean().optional(), mode: mode.optional() }).strict()) },
    responses: { 200: jsonResponse(z.object({ path: z.string(), ok: z.literal(true) })), ...failures },
  }, handler);
  register(api, 'delete', '/containers/files/remove', { ...common, operationId: 'removeContainerFile', summary: 'Remove a file or directory',
    description: `${common.description} Removes a symlink itself without following its target. Directories must be empty unless recursive=true. Missing paths return 404. Recursive deletion may partially complete before interruption. Root cannot be removed.`,
    request: { query: z.object({ ...identity, path, recursive: z.enum(['true', 'false']).optional() }), headers },
    responses: { 200: jsonResponse(z.object({ path: z.string(), ok: z.literal(true) })), ...failures },
  }, handler);
  register(api, 'post', '/containers/files/move', { ...common, operationId: 'moveContainerFile', summary: 'Move a file or directory',
    description: `${common.description} Destination must be unused and its parent must exist; no replacement or directory nesting is performed. Moves preserve symlinks. Across filesystems the guest may copy then remove, so interruption can leave both paths. Root and moves into the source subtree are rejected.`,
    request: { query: z.object(identity), headers, ...requestBody(z.object({ path, destination: path }).strict()) },
    responses: { 200: jsonResponse(z.object({ path: z.string(), destination: z.string(), ok: z.literal(true) })), ...failures },
  }, handler);
  register(api, 'patch', '/containers/files/chmod', { ...common, operationId: 'setContainerFileMode', summary: 'Set file permission bits',
    description: `${common.description} Changes the selected entry's permission bits. Leaf symlinks are rejected. No recursive chmod, owner changes or special mode bits. Root cannot be modified.`,
    request: { query: z.object({ ...identity, path }), headers, ...requestBody(z.object({ mode }).strict()) },
    responses: { 200: jsonResponse(z.object({ path: z.string(), mode, ok: z.literal(true) })), ...failures },
  }, handler);
}

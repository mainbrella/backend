import type { BuildFiles } from './build-contract';
import type { BuildAIMessage } from './build-ai';

export const BUILD_READ_CHARS = 8192;
export const BUILD_READ_BYTES = 8192;
export const BUILD_LIST_FILES = 100;
const encoder = new TextEncoder();

export function listBuildFiles(files: BuildFiles, offset = 0, limit = BUILD_LIST_FILES) {
  const paths = Object.keys(files).sort(), end = Math.min(paths.length, offset + limit);
  const listing = paths.slice(offset, end).join('\n');
  if (offset === 0 && end === paths.length) return listing;
  return `Files ${Math.min(offset, paths.length)}-${end} of ${paths.length} (zero-based).${end < paths.length ? ` Continue with list_files offset=${end}.` : ' End of file list.'}\n${listing}`;
}

/** Offsets count UTF-16 code units, so even single-line datasets can be paged. */
export function readBuildFile(content: string, path: string, offset = 0, limit = BUILD_READ_CHARS) {
  if (offset > content.length) return { succeeded: false, output: `Offset exceeds the file's ${content.length} characters.` };
  if (offset === 0 && content.length <= limit && encoder.encode(JSON.stringify(content)).length <= BUILD_READ_BYTES)
    return { succeeded: true, output: content };
  // Include metadata and JSON escaping in the model conversation byte bound.
  const render = (end: number) => JSON.stringify({ path, offset, nextOffset: end < content.length ? end : null,
    totalChars: content.length, content: content.slice(offset, end) });
  let low = offset, high = Math.min(content.length, offset + limit);
  while (low < high) {
    const end = Math.ceil((low + high) / 2);
    if (encoder.encode(JSON.stringify(render(end))).length <= BUILD_READ_BYTES) low = end;
    else high = end - 1;
  }
  // Never end a page in the middle of a surrogate pair.
  if (low > offset && low < content.length && /[\uD800-\uDBFF]/.test(content[low - 1]) && /[\uDC00-\uDFFF]/.test(content[low])) low--;
  return { succeeded: true, output: render(low) };
}

export function editBuildFile(content: string, oldText: string, newText: string) {
  const index = content.indexOf(oldText);
  if (index < 0) return { succeeded: false as const, output: 'The exact text was not found. Read the relevant file range before editing.' };
  if (content.indexOf(oldText, index + 1) >= 0)
    return { succeeded: false as const, output: 'The text matches more than once. Include enough surrounding text to identify a unique match.' };
  return { succeeded: true as const, content: content.slice(0, index) + newText + content.slice(index + oldText.length) };
}

/** Preserve call/response pairs and the latest reads; older bytes stay in source storage and diagnostics. */
export function compactBuildReads(messages: BuildAIMessage[], limit: number) {
  let bytes = encoder.encode(JSON.stringify(messages)).length;
  if (bytes <= limit) return bytes;
  let latest = messages.length - 1;
  while (latest >= 0 && !(messages[latest].role === 'assistant' && messages[latest].tool_calls?.length)) latest--;
  const reads = new Map<string, string>();
  for (let index = 0; index < latest && bytes > limit; index++) {
    const message = messages[index];
    for (const call of message.tool_calls ?? []) if (call.function.name === 'read_file') reads.set(call.id, call.function.arguments);
    if (message.role !== 'tool' || !message.tool_call_id || !message.tool_success || !reads.has(message.tool_call_id)) continue;
    const summary = `Earlier read_file result omitted to keep context bounded. The file remains available through read_file. Arguments: ${reads.get(message.tool_call_id)}`;
    const before = encoder.encode(JSON.stringify(message)).length;
    const replacement = { ...message, content: summary };
    const after = encoder.encode(JSON.stringify(replacement)).length;
    if (after < before) { messages[index] = replacement; bytes -= before - after; }
  }
  return bytes;
}

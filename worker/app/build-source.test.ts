import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILD_CONTEXT_BYTES, BUILD_MAX_FILE_BYTES, BUILD_MAX_FILES, validateBuildFiles } from '../lib/build-contract';
import { BUILD_READ_BYTES, listBuildFiles, readBuildFile, editBuildFile, compactBuildReads } from '../lib/build-source-tools';
import { buildToolSchemas, parseBuildTool, type BuildAIMessage } from '../lib/build-ai';

test('source storage accepts large datasets and enforces actual UTF-8 byte and file-count ceilings', () => {
  const files = { 'card-2026.json': JSON.stringify({ data: 'x'.repeat(300_000) }),
    ...Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`src/file-${index}.ts`, 'export {};'])) };
  validateBuildFiles(files);
  validateBuildFiles({ 'unicode.txt': '🌍'.repeat(BUILD_MAX_FILE_BYTES / 4) });
  assert.throws(() => validateBuildFiles({ 'unicode.txt': '🌍'.repeat(BUILD_MAX_FILE_BYTES / 4 + 1) }), /source_limit/);
  assert.throws(() => validateBuildFiles(Object.fromEntries(Array.from({ length: BUILD_MAX_FILES + 1 }, (_, index) => [`src/file-${index}.ts`, '']))), /source_limit/);
  assert.throws(() => validateBuildFiles(Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`data/file-${index}.json`, 'x'.repeat(BUILD_MAX_FILE_BYTES)]))), /source_limit/);
});

test('bounded reads reconstruct single-line Unicode and escaped content without filling model context', () => {
  const content = JSON.stringify({ data: '\u0000"\\\n🌍'.repeat(20_000) });
  let offset = 0, restored = '', pages = 0;
  do {
    const read = readBuildFile(content, 'dataset.json', offset);
    assert.equal(read.succeeded, true);
    assert.ok(Buffer.byteLength(JSON.stringify(read.output)) <= BUILD_READ_BYTES);
    const page = JSON.parse(read.output);
    assert.equal(page.offset, offset); assert.equal(page.totalChars, content.length);
    restored += page.content; pages++;
    if (page.nextOffset === null) break;
    assert.ok(page.nextOffset > offset);
    offset = page.nextOffset;
  } while (pages < 1000);
  assert.ok(pages > 1); assert.equal(restored, content);
  assert.deepEqual(readBuildFile('small file', 'small.txt'), { succeeded: true, output: 'small file' });
  assert.equal(readBuildFile(content, 'dataset.json', content.length + 1).succeeded, false);
  const end = JSON.parse(readBuildFile(content, 'dataset.json', content.length).output);
  assert.equal(end.content, ''); assert.equal(end.nextOffset, null);
});

test('file lists page long paths instead of adding a complete large index to model context', () => {
  const files = Object.fromEntries(Array.from({ length: 1024 }, (_, index) => [`src/${String(index).padStart(4, '0')}-${'x'.repeat(140)}.ts`, '']));
  const first = listBuildFiles(files), second = listBuildFiles(files, 100);
  assert.match(first, /Continue with list_files offset=100/);
  assert.match(second, /Continue with list_files offset=200/);
  assert.ok(Buffer.byteLength(first) < 20 * 1024);
  assert.ok(!first.includes('src/0100-')); assert.ok(second.includes('src/0100-'));
  assert.match(listBuildFiles(files, 1000), /End of file list/);
});

test('targeted edits preserve large unread data and reject missing or ambiguous matches', () => {
  const content = JSON.stringify({ data: 'x'.repeat(300_000), status: 'before' });
  const edit = editBuildFile(content, '"status":"before"', '"status":"after"');
  assert.equal(edit.succeeded, true);
  if (edit.succeeded) assert.deepEqual(JSON.parse(edit.content), { data: 'x'.repeat(300_000), status: 'after' });
  assert.equal(editBuildFile(content, 'missing', 'after').succeeded, false);
  assert.equal(editBuildFile('repeat repeat', 'repeat', 'after').succeeded, false);
  assert.equal(editBuildFile('aaa', 'aa', 'after').succeeded, false);
  assert.equal(buildToolSchemas.edit_file.safeParse({ path: 'data.json', old_text: '', new_text: 'after' }).success, false);
  assert.equal(buildToolSchemas.read_file.safeParse({ path: 'data.json', offset: -1 }).success, false);
  assert.equal(buildToolSchemas.read_file.safeParse({ path: 'data.json', limit: 100_000 }).success, false);
  assert.equal(parseBuildTool({ id: 'bad', type: 'function', function: { name: 'toString', arguments: '{}' } }), null);
});

test('context compaction preserves recent read bodies, call/response pairs, failures and user instructions', () => {
  const messages: BuildAIMessage[] = [{ role: 'system', content: 'Keep all user features.' }, { role: 'user', content: 'Update status only.' }];
  for (let round = 0; round < 6; round++) {
    messages.push({ role: 'assistant', content: `Read batch ${round}`, tool_calls: Array.from({ length: 8 }, (_, index) => ({ id: `${round}-${index}`, type: 'function' as const,
      function: { name: 'read_file', arguments: JSON.stringify({ path: 'data.json', offset: round * 8 + index }) } })) });
    for (let index = 0; index < 8; index++) messages.push({ role: 'tool', tool_call_id: `${round}-${index}`, content: 'x'.repeat(8000), tool_success: true });
  }
  messages.splice(2, 0, { role: 'assistant', content: null, tool_calls: [{ id: 'failed', type: 'function', function: { name: 'read_file', arguments: '{"path":"missing.json"}' } }] },
    { role: 'tool', tool_call_id: 'failed', content: 'File not found.', tool_success: false });
  const before = messages.length, latest = structuredClone(messages.slice(-9));
  const bytes = compactBuildReads(messages, BUILD_CONTEXT_BYTES);
  assert.ok(bytes <= BUILD_CONTEXT_BYTES);
  assert.equal(bytes, Buffer.byteLength(JSON.stringify(messages)));
  assert.equal(messages.length, before);
  assert.deepEqual(messages.slice(-9), latest);
  assert.equal(messages[0].content, 'Keep all user features.'); assert.equal(messages[1].content, 'Update status only.');
  assert.equal(messages[3].content, 'File not found.');
  assert.ok(messages.some(message => message.content?.includes('Earlier read_file result omitted')));
  for (const call of messages.flatMap(message => message.tool_calls ?? []))
    assert.ok(messages.some(message => message.role === 'tool' && message.tool_call_id === call.id));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { Mainbrella } = await import(process.env.MAINBRELLA_SDK_MODULE || './index.js');

function sandbox(fetch) {
  return new Mainbrella({ apiKey: `mb_${'a'.repeat(64)}`, fetch }).connect({ id: 'small', createdAt: '2026-10-05T12:00:00.000Z' });
}

test('file stream helpers preserve streaming bodies, byte lengths and abort signals', async () => {
  const bytes = new Uint8Array([0, 128, 255]); let calls = 0;
  const f = sandbox(async (url, options) => {
    calls++;
    assert.equal(url.pathname, '/containers/files/transfer'); assert.equal(url.searchParams.get('path'), '/workspace/界.bin');
    assert.equal(url.searchParams.get('createdAt'), '2026-10-05T12:00:00.000Z');
    if (options.method === 'PUT') {
      assert.equal(options.duplex, 'half'); assert.equal(options.headers['Content-Type'], 'application/octet-stream');
      assert.equal(url.searchParams.get('size'), '3'); assert.ok(options.body instanceof ReadableStream);
      assert.deepEqual(new Uint8Array(await new Response(options.body).arrayBuffer()), bytes);
      return Response.json({ path: '/workspace/界.bin', size: 3 });
    }
    return new Response(bytes, { headers: { 'content-length': '3' } });
  });
  await f.files.upload('/workspace/界.bin', new Blob([bytes]).stream(), { size: 3 });
  assert.deepEqual(new Uint8Array(await new Response(await f.files.download('/workspace/界.bin')).arrayBuffer()), bytes);
  assert.equal(calls, 2);
  assert.throws(() => f.files.upload('/file', bytes, { size: 4 }), /invalid_transfer_size/);
  assert.throws(() => f.files.upload('/file', new Blob().stream()), /invalid_transfer_size/);
  const bad = sandbox(async () => new Response(bytes, { headers: { 'content-length': '4' } }));
  await assert.rejects(new Response(await bad.files.download('/file')).arrayBuffer(), /file_size_mismatch/);
});

test('directory transfers copy nested binary files and reject symlinks without escaping the local root', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mainbrella-sdk-files-')); t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'), destination = join(root, 'destination');
  await mkdir(join(source, 'nested'), { recursive: true });
  const bytes = Uint8Array.from({ length: 1024 * 1024 + 5 }, (_, i) => i % 256); await writeFile(join(source, 'nested', 'binary'), bytes);
  const remote = new Map();
  const f = sandbox(async (url, options) => {
    const path = url.searchParams.get('path');
    if (url.pathname.endsWith('/mkdir')) { const { path } = JSON.parse(options.body); remote.set(path, { type: 'directory' }); return Response.json({ path, ok: true }); }
    if (url.pathname.endsWith('/transfer')) {
      if (options.method === 'PUT') { const data = new Uint8Array(await new Response(options.body).arrayBuffer()); remote.set(path, { type: 'file', bytes: data }); return Response.json({ path, size: data.length }); }
      const data = remote.get(path).bytes; return new Response(data, { headers: { 'content-length': String(data.length) } });
    }
    const entries = [...remote].filter(([key]) => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes('/'))
      .map(([key, value]) => ({ name: key.slice(path.length + 1), path: key, type: value.type, size: value.bytes?.length ?? 0 }));
    return Response.json({ entries, nextOffset: null });
  });
  await f.files.uploadDirectory(source, '/workspace/tree');
  assert.deepEqual(remote.get('/workspace/tree/nested/binary').bytes, bytes);
  await f.files.downloadDirectory('/workspace/tree', destination);
  assert.deepEqual(new Uint8Array(await readFile(join(destination, 'nested', 'binary'))), bytes);
  await symlink(source, join(source, 'unsafe'));
  await assert.rejects(f.files.uploadDirectory(source, '/workspace/tree'), /symlink_not_allowed/);
  await rm(join(destination, 'nested'), { recursive: true }); await symlink(source, join(destination, 'nested'));
  await assert.rejects(f.files.downloadDirectory('/workspace/tree', destination), /symlink_not_allowed/);
});

test('metadata watches report create/modify/remove and are cancelable between polls', async () => {
  let polls = 0;
  const f = sandbox(async () => Response.json({ entries: (++polls === 1 ? [{ name: 'old', type: 'file', size: 1 }]
    : [{ name: 'new', type: 'file', size: 2 }]), nextOffset: null }));
  const abort = new AbortController();
  const events = f.files.watch('/workspace', { intervalMs: 250, signal: abort.signal });
  assert.equal((await events.next()).value.type, 'create');
  assert.equal((await events.next()).value.type, 'remove');
  const next = events.next(); abort.abort(); await assert.rejects(next); await events.return();
});

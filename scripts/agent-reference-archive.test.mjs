import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { agentReferenceArchive } from './agent-reference-archive.mjs';

test('reference archive is deterministic, normalized USTAR with no metadata entries', () => {
  const files = { 'SKILL.md': 'Hello\n', 'references/index.md': 'Reference\n', 'LICENSE': 'License\n' };
  const archive = agentReferenceArchive(files);
  assert.deepEqual(archive, agentReferenceArchive(Object.fromEntries(Object.entries(files).reverse())));
  assert.equal(archive.readUInt32LE(4), 0, 'gzip timestamp');
  assert.equal(archive[9], 255, 'gzip host OS');
  const tar = gunzipSync(archive);
  const names = [];
  for (let offset = 0; tar[offset];) {
    const header = tar.subarray(offset, offset + 512);
    const field = (start, length) => header.subarray(start, start + length).toString().replace(/\0.*$/s, '');
    const name = field(0, 100);
    names.push(name);
    const directory = name.endsWith('/');
    assert.equal(field(156, 1), directory ? '5' : '0');
    assert.equal(field(257, 6), 'ustar');
    assert.equal(field(263, 2), '00');
    assert.equal(parseInt(field(100, 8), 8), directory ? 0o755 : 0o644);
    for (const [start, length] of [[108, 8], [116, 8], [136, 12]]) assert.equal(parseInt(field(start, length), 8), 0);
    assert.equal(field(265, 32), '');
    assert.equal(field(297, 32), '');
    const size = parseInt(field(124, 12), 8);
    if (!directory) assert.equal(tar.subarray(offset + 512, offset + 512 + size).toString(), files[name.slice('mainbrella-containers/'.length)]);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.deepEqual(names, ['mainbrella-containers/', 'mainbrella-containers/LICENSE', 'mainbrella-containers/SKILL.md', 'mainbrella-containers/references/', 'mainbrella-containers/references/index.md']);
  assert.deepEqual(tar.subarray(-1024), Buffer.alloc(1024));
});

test('repeated reference builds produce identical archives readable by system tar', async () => {
  const work = await mkdtemp(join(tmpdir(), 'mainbrella-archive-test-'));
  try {
    const script = new URL('./build-agent-reference.mjs', import.meta.url);
    for (const name of ['first', 'second']) execFileSync(process.execPath, [script.pathname, '--out', join(work, name)], { env: { ...process.env, COPYFILE_DISABLE: '0' } });
    const version = JSON.parse(await readFile(new URL('../sdk/javascript/package.json', import.meta.url))).version;
    const path = name => join(work, name, `mainbrella-containers-${version}.tar.gz`);
    assert.deepEqual(await readFile(path('first')), await readFile(path('second')));
    const listing = execFileSync('tar', ['-tzf', path('first')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().split('\n');
    assert.ok(listing.every(name => name.startsWith('mainbrella-containers/')));
    for (const name of listing.filter(name => !name.endsWith('/'))) {
      assert.deepEqual(execFileSync('tar', ['-xOzf', path('first'), name]), await readFile(join(work, 'first', name)));
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

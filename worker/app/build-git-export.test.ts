import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readBuildGitChain, type BuildGitBundle } from '../lib/build-git-bundle';
import { exportBuildGitBundles } from '../lib/build-git-export';

const owner = { userId: 'export-user', appId: 'export-app' }, prefix = 'build-git/export-user/export-app/';
const sha = (algorithm: string, bytes: Uint8Array) => createHash(algorithm).update(bytes).digest('hex');
function fixture(t: TestContext) {
  const disk = mkdtempSync(join(tmpdir(), 'mainbrella-git-export-'));
  t.after(() => rmSync(disk, { recursive: true, force: true }));
  const objects = new Map<string, Uint8Array>(), reads: string[] = [];
  const env = { BUCKET: { async get(key: string) {
    reads.push(key);
    const bytes = objects.get(key);
    return bytes ? { size: bytes.length, arrayBuffer: async () => new Uint8Array(bytes).buffer,
      json: async () => JSON.parse(Buffer.from(bytes).toString()) } : null;
  } } } as unknown as Env;
  function store(bytes: Uint8Array, commitId: string, parent: { commitId: string; key: string } | null, stride = 1024 * 1024) {
    const parts = [];
    for (let offset = 0; offset < bytes.length; offset += stride) {
      const part = new Uint8Array(bytes.subarray(offset, offset + stride)), hash = sha('sha256', part), key = `${prefix}parts/${hash}`;
      objects.set(key, part); parts.push({ key, size: part.length, sha256: hash });
    }
    const manifest: BuildGitBundle = { schemaVersion: 2, commitId, size: bytes.length, parts,
      prerequisiteCommitId: parent?.commitId ?? null, previousBundleKey: parent?.key ?? null };
    const key = `${prefix}bundles/${commitId}.json`;
    objects.set(key, Buffer.from(JSON.stringify(manifest)));
    return { commitId, key, manifest };
  }
  async function clone(key: string, commitId: string, label = 'clone') {
    const chain = await readBuildGitChain(env, owner, key), response = await exportBuildGitBundles(env, owner, chain, commitId, {});
    const bytes = new Uint8Array(await response.arrayBuffer()), bundle = join(disk, `${label}.bundle`), destination = join(disk, label);
    assert.equal(Number(response.headers.get('Content-Length')), bytes.length);
    writeFileSync(bundle, bytes);
    git(['clone', '-q', '-b', 'main', bundle, destination], disk);
    git(['fsck', '--full'], destination);
    assert.equal(git(['rev-parse', 'HEAD'], destination), commitId);
    return destination;
  }
  return { disk, env, objects, reads, store, clone };
}
function git(args: string[], cwd: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return result.stdout.trim();
}

test('exports stream multipart bundles with bounded caching, Unicode prerequisites and repeated restores', async t => {
  const f = fixture(t), repo = join(f.disk, 'repo'); mkdirSync(repo);
  git(['init', '-q', '-b', 'main'], repo);
  let parent: ReturnType<typeof f.store> | null = null, initial = '';
  const original = randomBytes(1400000);
  for (let i = 0; i < 7; i++) {
    writeFileSync(join(repo, 'image.bin'), i % 3 === 0 ? original : randomBytes(1400000));
    git(['add', '.'], repo);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', `Création ${i} 日本語`], repo);
    const commitId = git(['rev-parse', 'HEAD'], repo), file = join(f.disk, 'part.bundle');
    git([...(parent ? ['-c', 'pack.window=0', '-c', 'pack.depth=0', '-c', 'pack.allowPackReuse=false'] : []), 'bundle', 'create', file, 'main', ...(parent ? [`^${parent.commitId}`] : [])], repo);
    const bytes = readFileSync(file);
    // Put the last ten checksum bytes in their own storage part.
    parent = f.store(bytes, commitId, parent, bytes.length - 10 > 1024 * 1024 ? Math.ceil((bytes.length - 10) / 2) : bytes.length - 10);
    if (!initial) initial = commitId;
    // Reuse actual Git delta representations from packed local history on the next save.
    git(['repack', '-adb'], repo);
  }
  const clone = await f.clone(parent!.key, parent!.commitId);
  assert.equal(git(['rev-list', '--count', 'HEAD'], clone), '7');
  assert.equal(git(['rev-parse', 'HEAD~6'], clone), initial);
  assert.deepEqual(readFileSync(join(clone, 'image.bin')), original);
});

test('one thousand dependent bundles export all commit IDs as a self-contained repository', async t => {
  const f = fixture(t), empty = Buffer.alloc(0), treeId = sha('sha1', Buffer.from('tree 0\0'));
  const commits: string[] = [];
  let parent: ReturnType<typeof f.store> | null = null;
  for (let i = 0; i < 1000; i++) {
    const commit = Buffer.from(`tree ${treeId}\n${parent ? `parent ${parent.commitId}\n` : ''}author Test <test@example.com> ${1700000000 + i} +0000\ncommitter Test <test@example.com> ${1700000000 + i} +0000\n\nCommit ${i}\n`);
    const id = sha('sha1', Buffer.concat([Buffer.from(`commit ${commit.length}\0`), commit]));
    const packHeader = Buffer.alloc(12); packHeader.write('PACK'); packHeader.writeUInt32BE(2, 4); packHeader.writeUInt32BE(i === 0 ? 2 : 1, 8);
    const entries = [packedObject(1, commit), ...(i === 0 ? [packedObject(2, empty)] : [])];
    const pack = Buffer.concat([packHeader, ...entries]);
    const header = Buffer.from(`# v2 git bundle\n${parent ? `-${parent.commitId} prerequisite\n` : ''}${id} refs/heads/main\n\n`);
    parent = f.store(Buffer.concat([header, pack, createHash('sha1').update(pack).digest()]), id, parent);
    commits.push(id);
  }
  const clone = await f.clone(parent!.key, parent!.commitId);
  assert.deepEqual(git(['rev-list', '--reverse', 'HEAD'], clone).split('\n'), commits);
  assert.equal(f.reads.length, 2000, 'Each manifest and part is read once');
});

// Full-object pack fixtures exercise the transport against native Git, without
// running one subprocess for each commit in the thousand-bundle test.
function packedObject(type: number, bytes: Uint8Array) {
  const header = [], size = bytes.length;
  let rest = Math.floor(size / 16);
  header.push((type << 4) | (size & 15) | (rest ? 128 : 0));
  while (rest) { const low = rest & 127; rest = Math.floor(rest / 128); header.push(low | (rest ? 128 : 0)); }
  return Buffer.concat([Buffer.from(header), deflateSync(bytes)]);
}

test('invalid dependency graphs fail closed before export', async t => {
  for (const bad of ['cycle', 'missing', 'foreign', 'wrong-prerequisite', 'unknown-schema', 'invalid-size']) await t.test(bad, async sub => {
    const f = fixture(sub), first = 'a'.repeat(40), second = 'b'.repeat(40);
    const initial = f.store(Buffer.from('base'), first, null), increment = f.store(Buffer.from('increment'), second, initial);
    const value = { ...increment.manifest };
    if (value.schemaVersion !== 2) assert.fail();
    if (bad === 'cycle') value.previousBundleKey = increment.key;
    if (bad === 'missing') f.objects.delete(initial.key);
    if (bad === 'foreign') value.previousBundleKey = 'build-git/another-user/app/bundles/base';
    if (bad === 'wrong-prerequisite') value.prerequisiteCommitId = 'c'.repeat(40);
    if (bad === 'unknown-schema') Object.assign(value, { schemaVersion: 3 });
    if (bad === 'invalid-size') value.size++;
    f.objects.set(increment.key, Buffer.from(JSON.stringify(value)));
    await assert.rejects(readBuildGitChain(f.env, owner, increment.key), /build_git_unavailable/);
  });
});

test('exports reject corrupted bundle parts even when object sizes still match', async t => {
  const f = fixture(t), repo = join(f.disk, 'repo'); mkdirSync(repo);
  git(['init', '-q', '-b', 'main'], repo);
  writeFileSync(join(repo, 'file'), randomBytes(20000)); git(['add', '.'], repo);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'Base'], repo);
  const id = git(['rev-parse', 'HEAD'], repo), file = join(f.disk, 'base.bundle');
  git(['bundle', 'create', file, 'main'], repo);
  const saved = f.store(readFileSync(file), id, null, 10000), part = saved.manifest.parts[1];
  const bad = f.objects.get(part.key)!.slice(); bad[0] ^= 1; f.objects.set(part.key, bad);
  const response = await exportBuildGitBundles(f.env, owner, [saved.manifest], id, {});
  await assert.rejects(response.arrayBuffer(), /Repository unavailable/);
});

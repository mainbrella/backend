import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readGitPack, gitFetchBody } from '../lib/github-import';
import { privateCloneCommand, importPartPath } from '../lib/repo-launch';

const pkt = (bytes: Uint8Array | string) => {
  const body = Buffer.from(bytes); return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, '0')), body]);
};
const stream = (bytes: Uint8Array, stride = 17) => new ReadableStream<Uint8Array>({ start(controller) {
  for (let i = 0; i < bytes.length; i += stride) controller.enqueue(bytes.slice(i, i + stride)); controller.close();
} });

test('private import reconstructs a real shallow checkout and supports local commits without any GitHub credentials', async t => {
  const temp = mkdtempSync(join(tmpdir(), 'mainbrella-import-')); t.after(() => rmSync(temp, { recursive: true, force: true }));
  const source = join(temp, 'source'), workspace = join(temp, 'workspace'); mkdirSync(source); mkdirSync(workspace);
  const git = (...args: string[]) => execFileSync('git', ['-C', source, ...args]);
  git('init', '-q'); writeFileSync(join(source, 'README.md'), 'private repository data\n'); git('add', '.');
  git('-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-qm', 'Base commit');
  const commit = git('rev-parse', 'HEAD').toString().trim();
  const pack = execFileSync('git', ['-C', source, 'pack-objects', '--revs', '--stdout'], { input: `${commit}\n` });
  const wire = Buffer.concat([pkt(`shallow ${commit}\n`), Buffer.from('0000'), pkt('NAK\n'),
    pkt(Buffer.concat([Buffer.from([1]), pack])), Buffer.from('0000')]);
  const decoded = await readGitPack(stream(wire)); assert.deepEqual(Buffer.from(decoded), pack);
  const id = '12345678-1234-1234-1234-123456789abc';
  const repo = { repo: 'acme/private', ref: 'main', commit, private: true, suggestedCatalogId: 'node', manifests: [] };
  const part = importPartPath(id, 0).replace('/workspace', workspace); writeFileSync(part, decoded);
  // tmux is the only guest-specific command; checkout is executed with real Git and Bash.
  const bin = join(temp, 'bin'); mkdirSync(bin); writeFileSync(join(bin, 'tmux'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const command = privateCloneCommand(repo, id, 1).replaceAll('/workspace', workspace);
  execFileSync('/bin/bash', ['-c', command], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  const checkout = join(workspace, 'repo');
  assert.equal(execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD']).toString().trim(), commit);
  assert.equal(readFileSync(join(checkout, 'README.md'), 'utf8'), 'private repository data\n');
  assert.equal(readFileSync(join(checkout, '.git/shallow'), 'utf8').trim(), commit);
  assert.throws(() => readFileSync(part));
  assert.equal(execFileSync('git', ['-C', checkout, 'remote', 'get-url', 'origin']).toString().trim(), 'https://github.com/acme/private.git');
  writeFileSync(join(checkout, 'README.md'), 'updated privately\n');
  execFileSync('git', ['-C', checkout, 'add', '.']);
  execFileSync('git', ['-C', checkout, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-qm', 'Local edit']);
  assert.equal(execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD^']).toString().trim(), commit);
  assert.doesNotMatch(command + readFileSync(join(checkout, '.git/config'), 'utf8'), /ghu_|ghs_|Authorization|credential.helper/);
});

test('pack decoding rejects protocol errors, truncated responses and malformed packets', async () => {
  for (const wire of [Buffer.from('zzzz'), pkt('ERR access denied'), pkt('NAK\n'), Buffer.from('0010short'),
    Buffer.concat([pkt(Buffer.from([3, 65])), Buffer.from('0000')]), Buffer.concat([pkt(Buffer.from([1, ...Buffer.alloc(40)])), Buffer.from('0000')])])
    await assert.rejects(readGitPack(stream(wire)));
  assert.throws(() => gitFetchBody('x\nwant other'), /invalid_request/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, rename, chmod, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const { Mainbrella } = await import(process.env.MAINBRELLA_SDK_MODULE || './index.js');
const author = { name: 'SDK Test', email: 'sdk-test@example.invalid' };
const raw = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  assert.equal(result.status, 0, result.stderr); return result.stdout;
};
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'mainbrella-git-')); t.after(() => rm(cwd, { recursive: true, force: true }));
  raw(cwd, 'init', '-b', 'main');
  const sandbox = new Mainbrella({ apiKey: 'mb_' + 'a'.repeat(64), fetch: () => assert.fail('Local adapter') }).connect({ id: 'small', createdAt: '2026-10-12T14:00:00.000Z' });
  const calls = [];
  sandbox.commands.start = async (argv, options) => {
    calls.push({ argv, options });
    const result = spawnSync(argv[0], argv.slice(1), { cwd: options.cwd, env: { ...process.env, ...options.env }, encoding: 'utf8', timeout: options.timeoutMs });
    return { id: crypto.randomUUID(), wait: async () => ({ stdout: result.stdout, stderr: result.stderr, exitCode: result.status,
      status: result.status === 0 ? 'succeeded' : 'failed', outputTruncated: false, timedOut: false }) };
  };
  return { cwd, sandbox, calls };
}

test('Git helpers operate on real staged files, literal odd filenames, local branches and safe checkout', async t => {
  const { cwd, sandbox, calls } = await fixture(t), git = sandbox.git;
  const original = 'with space\nand newline.txt', renamed = '-$(touch injected).txt';
  await writeFile(join(cwd, original), 'before\n'); raw(cwd, 'add', '--', original);
  assert.equal((await git.diff({ cwd, staged: true, paths: [original] })).patch.includes('+before'), true);
  const first = await git.commit({ cwd, message: 'First $(touch injected)', author, idempotencyKey: 'first-commit' });
  assert.equal(first.committed, true);
  assert.deepEqual((await git.status({ cwd })).entries, []);
  assert.equal(raw(cwd, 'log', '-1', '--format=%an <%ae>').trim(), 'SDK Test <sdk-test@example.invalid>');
  await git.checkout({ cwd, branch: 'work/topic', create: true, idempotencyKey: 'new-branch' });
  raw(cwd, 'tag', 'work/topic');
  await rename(join(cwd, original), join(cwd, renamed)); raw(cwd, 'add', '-A');
  const status = await git.status({ cwd });
  assert.deepEqual(status.entries, [{ indexStatus: 'R', worktreeStatus: ' ', path: renamed, originalPath: original }]);
  const branches = (await git.branches({ cwd })).branches;
  assert.deepEqual(branches.map(branch => [branch.name, branch.current]), [['main', false], ['work/topic', true]]);
  await git.commit({ cwd, message: 'Rename', author, idempotencyKey: 'rename-commit' });
  await writeFile(join(cwd, renamed), 'unsaved change\n');
  await assert.rejects(git.checkout({ cwd, branch: 'main', idempotencyKey: 'would-overwrite' }), error => error.code === 'git_command_failed' && error.exitCode !== 0 && Boolean(error.executionId));
  assert.equal(await readFile(join(cwd, renamed), 'utf8'), 'unsaved change\n');
  await assert.rejects(access(join(cwd, 'injected')));
  assert.ok(calls.every(call => Array.isArray(call.argv) && call.options.cwd === cwd));
});

test('Git conveniences disable hooks, signing, custom filters, external diff and text conversion', async t => {
  const { cwd, sandbox } = await fixture(t), git = sandbox.git;
  await writeFile(join(cwd, 'tracked'), 'before\n'); raw(cwd, 'add', 'tracked');
  await git.commit({ cwd, message: 'Base', author, idempotencyKey: 'base' });
  const marker = join(cwd, 'executed'), command = `touch '${marker}'; cat`;
  raw(cwd, 'config', 'filter.trap.clean', command); raw(cwd, 'config', 'filter.trap.smudge', command);
  raw(cwd, 'config', 'filter.trap.required', 'true'); raw(cwd, 'config', 'diff.trap.command', command);
  raw(cwd, 'config', 'diff.trap.textconv', command); raw(cwd, 'config', 'commit.gpgsign', 'true');
  await writeFile(join(cwd, '.gitattributes'), '* filter=trap diff=trap\n');
  const hook = join(cwd, '.git/hooks/pre-commit'); await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`); await chmod(hook, 0o700);
  await writeFile(join(cwd, 'tracked'), 'after\n');
  assert.ok((await git.status({ cwd })).entries.length);
  assert.ok((await git.diff({ cwd })).patch.includes('+after'));
  await git.checkout({ cwd, branch: 'other', create: true, idempotencyKey: 'branch' });
  raw(cwd, '-c', 'filter.trap.clean=', '-c', 'filter.trap.required=false', 'add', 'tracked');
  await git.commit({ cwd, message: 'No configured executable', author, idempotencyKey: 'commit-safe' });
  await git.checkout({ cwd, branch: 'main', idempotencyKey: 'restore-filtered-file' });
  assert.equal(await readFile(join(cwd, 'tracked'), 'utf8'), 'before\n');
  await assert.rejects(access(marker));
});

test('Git validation blocks branch options and incomplete output before parsing or mutating', async t => {
  const { cwd, sandbox, calls } = await fixture(t), git = sandbox.git;
  for (const branch of ['-C', '@{-1}', 'a..b', 'name.lock', 'x\ncommand']) {
    await assert.rejects(git.checkout({ cwd, branch, idempotencyKey: 'invalid' }), { code: 'invalid_git_options' });
  }
  await assert.rejects(git.commit({ cwd, message: 'x', author }), { code: 'invalid_git_options' });
  assert.equal(calls.length, 0);
  sandbox.commands.start = async () => ({ id: 'retained', wait: async () => ({ outputTruncated: true, stdout: '?? partial', stderr: '', exitCode: 0, status: 'succeeded' }) });
  await assert.rejects(git.status({ cwd, idempotencyKey: 'read-key' }), { code: 'git_output_limit', executionId: 'retained', idempotencyKey: 'read-key' });
});

test('ambiguous Git mutation admission retains its key without claiming the configuration execution', async t => {
  const { cwd, sandbox } = await fixture(t);
  let starts = 0;
  sandbox.commands.start = async () => {
    if (++starts === 2) throw new Error('transport unavailable');
    return { id: 'configuration-only', wait: async () => ({ status: 'failed', exitCode: 1, stdout: '', stderr: '', timedOut: false, outputTruncated: false }) };
  };
  await assert.rejects(sandbox.git.commit({ cwd, author, message: 'one mutation', idempotencyKey: 'mutation-key' }), error =>
    error.idempotencyKey === 'mutation-key' && error.gitPhase === 'operation' && error.configurationExecutionId === 'configuration-only' && !error.executionId);
  assert.equal(starts, 2);
});

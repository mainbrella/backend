import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

function deployFixture(t, migrationStatus = 0) {
  const directory = mkdtempSync(join(tmpdir(), 'mainbrella-deploy-api-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ private: true, scripts }));
  const bin = join(directory, 'bin');
  const log = join(directory, 'wrangler.jsonl');
  mkdirSync(bin);
  writeFileSync(join(bin, 'wrangler'), `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(process.env.DEPLOY_TEST_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'd1') process.exit(Number(process.env.DEPLOY_TEST_MIGRATION_STATUS));
`, { mode: 0o755 });
  return {
    run: args => spawnSync('npm', ['run', 'deploy:api', ...args], {
      cwd: directory,
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`,
        DEPLOY_TEST_LOG: log, DEPLOY_TEST_MIGRATION_STATUS: String(migrationStatus) },
      encoding: 'utf8', timeout: 30_000,
    }),
    calls: () => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)),
  };
}

test('npm run deploy:api migrates before publishing and forwards Wrangler options only to deployment', t => {
  const { run, calls } = deployFixture(t);
  const result = run(['--', '--outdir=custom-output', '--var', 'TEST_FLAG:true']);
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.deepEqual(calls(), [
    ['d1', 'migrations', 'apply', 'delta', '--remote'],
    ['deploy', '--config', 'wrangler.jsonc', '--outdir=custom-output', '--var', 'TEST_FLAG:true'],
  ]);
});

test('npm run deploy:api stops before publishing when remote migration fails', t => {
  const { run, calls } = deployFixture(t, 1);
  const result = run([]);
  assert.equal(result.status, 1, result.error?.message ?? result.stderr);
  assert.deepEqual(calls(), [['d1', 'migrations', 'apply', 'delta', '--remote']]);
});

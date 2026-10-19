import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deployStagingBackend, parseArguments } from './staging-backend.mjs';
import { STAGING } from './staging-config.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'canopy-backend-auth-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, '.'), { recursive: true });
  const wrangler = join(directory, 'node_modules/wrangler');
  mkdirSync(wrangler, { recursive: true });
  writeFileSync(join(wrangler, 'package.json'), '{"name":"wrangler","version":"0.0.0"}');
  writeFileSync(join(directory, 'package.json'), '{"name":"mainbrella-backend"}');
  return directory;
}

test('backend command requires an explicit check or publish flag', () => {
  assert.deepEqual(parseArguments(['--check']), { publish: false });
  assert.deepEqual(parseArguments(['--publish']), { publish: true });
  for (const args of [[], ['--publish', 'api'], ['--publish', '--check'], ['--force']]) {
    assert.throws(() => parseArguments(args), /Usage:/);
  }
});

test('offline backend check does not read credentials or call providers', async () => {
  const original = { SAFE: 'yes' };
  const result = await deployStagingBackend({ env: original,
    run: () => { throw new Error('Offline check read credentials'); },
    operation: async (name, options) => {
      assert.equal(name, 'check-backend');
      assert.equal(options.target, 'all');
      assert.equal(options.env.CLOUDFLARE_API_TOKEN, undefined);
      assert.equal(options.env.CLOUDFLARE_ACCOUNT_ID, STAGING.accountId);
      return { checked: true };
    },
  });
  assert.deepEqual(result, { checked: true });
  assert.deepEqual(original, { SAFE: 'yes' });
});

test('publish obtains the local Wrangler token in memory without printing or mutating caller env', async t => {
  const directory = fixture(t);
  const env = { SAFE: 'yes' };
  const calls = [], logs = [];
  await deployStagingBackend({ publish: true, directory, env, log: text => logs.push(text),
    run: (command, args, options) => {
      calls.push({ command, args, options });
      assert.equal(command, process.execPath);
      assert.deepEqual(args.slice(1), ['auth', 'token', '--json']);
      assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
      assert.equal(options.env.WRANGLER_WRITE_LOGS, 'false');
      return '{"type":"oauth","token":"private-token-for-test"}';
    },
    operation: async (name, options) => {
      assert.equal(name, 'bootstrap-backend');
      assert.equal(options.env.CLOUDFLARE_API_TOKEN, 'private-token-for-test');
      assert.equal(options.env.CLOUDFLARE_ACCOUNT_ID, STAGING.accountId);
      assert.equal(options.directory, directory);
    },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(env, { SAFE: 'yes' });
  assert.deepEqual(logs, []);
});

test('explicit credentials are reused and mismatched account inputs stop before credential reads', async () => {
  const run = () => { throw new Error('Unexpected credential read'); };
  let invoked = false;
  await deployStagingBackend({ publish: true, run, env: { CLOUDFLARE_API_TOKEN: 'explicit-test-token' },
    operation: async (name, options) => { invoked = true; assert.equal(name, 'bootstrap-backend'); assert.equal(options.env.CLOUDFLARE_API_TOKEN, 'explicit-test-token'); },
  });
  assert.equal(invoked, true);
  for (const key of ['CLOUDFLARE_ACCOUNT_ID', 'CF_ACCOUNT_ID']) {
    await assert.rejects(deployStagingBackend({ publish: true, run, env: { [key]: 'other-account' } }), /must match/);
  }
});

test('credential failures never echo provider output or reach deployment', async t => {
  const directory = fixture(t);
  for (const run of [
    () => '{"type":"global_key","token":"private-value"}',
    () => 'invalid private-value',
    () => { throw new Error('private-value'); },
  ]) {
    await assert.rejects(deployStagingBackend({ publish: true, directory, env: {}, run,
      operation: () => { throw new Error('Unexpected deployment'); },
    }), error => error.message.includes('credentials are unavailable') && !error.message.includes('private-value'));
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { artifactHash, dispatchRelease, parseArguments, release, validateConfiguration } from './release.mjs';
import { targetFor, targets } from './deploy-targets.mjs';

const sourceSha = 'a'.repeat(40);
const deploymentVersion = '12345678-1234-1234-1234-123456789abc';
const productionEnv = {
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: 'mainbrella/backend',
  GITHUB_WORKFLOW_REF: 'mainbrella/backend/.github/workflows/deploy.yml@refs/heads/main',
  RELEASE_SHA: sourceSha,
};

function withoutConsoleOutput(callback) {
  const log = console.log;
  console.log = () => {};
  try { return callback(); } finally { console.log = log; }
}

function fixture(t, name, directory = mkdtempSync(join(tmpdir(), 'canopy-deploy-'))) {
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const target = targetFor(name);
  const app = join(directory, target.directory);
  mkdirSync(app, { recursive: true });
  const wranglerPackage = join(app, 'node_modules/wrangler');
  mkdirSync(join(wranglerPackage, 'bin'), { recursive: true });
  writeFileSync(join(wranglerPackage, 'package.json'), JSON.stringify({ name: 'wrangler', version: '0.0.0' }));
  writeFileSync(join(wranglerPackage, 'bin/wrangler.js'), '');
  if (target.assets) {
    const assetDirectory = join(app, target.assets);
    mkdirSync(assetDirectory, { recursive: true });
    writeFileSync(join(assetDirectory, 'index.html'), '<main>built</main>');
  }
  writeFileSync(join(app, target.config), JSON.stringify(mockConfig(target), null, 2) + '\n');
  return { directory, app, target };
}

function stubRun(log, { failOn = null, status = '', sha = sourceSha, credential = { type: 'oauth', token: 'private-local-test-token' }, onCall = () => {},
  publicationContent, deploymentRows, onPublish = () => {} } = {}) {
  return (command, args, options = {}) => {
    const call = { command, args, cwd: options.cwd, env: options.env };
    log.push(call);
    onCall(call);
    if (failOn === `${command} ${args.join(' ')}`) throw new Error(`stub failed: ${failOn}`);
    if (command === 'git' && args[0] === 'status') return status;
    if (command === 'git' && args[0] === 'rev-parse') return sha;
    if (command === 'git' && args[0] === 'remote') return 'git@github.com:mainbrella/backend.git';
    if (command === process.execPath && args.includes('auth') && args.includes('token')) return JSON.stringify(credential);
    if (command === 'npm' && args[0] === 'run') {
      const targetName = Object.keys(targets).find(name => targets[name].publish === args[1]);
      if (targetName) {
        const receiptPath = options.env?.WRANGLER_OUTPUT_FILE_PATH;
        assert.ok(receiptPath, 'only the scoped publisher receives the Wrangler output path');
        mkdirSync(dirname(receiptPath), { recursive: true });
        const content = typeof publicationContent === 'function'
          ? publicationContent(targets[targetName])
          : publicationContent ?? [
            { type: 'build', worker_name: targets[targetName].worker, version_id: deploymentVersion },
            { type: 'deploy', worker_name: targets[targetName].worker, version_id: null },
            { type: 'deploy', worker_name: targets[targetName].worker, version_id: deploymentVersion },
          ].map(JSON.stringify).join('\n') + '\n';
        writeFileSync(receiptPath, content);
        const output = args.find(arg => arg.startsWith('--outdir='))?.slice('--outdir='.length);
        assert.ok(output, 'publisher saves its actual bundle for release evidence');
        mkdirSync(join(options.cwd, output), { recursive: true });
        writeFileSync(join(options.cwd, output, 'worker.js'), 'published bundle');
        onPublish({ target: targets[targetName], options, receiptPath });
        if (options.env.CANOPY_SITE_ASSET_SNAPSHOT) cpSync(join(options.cwd, 'dist'), options.env.CANOPY_SITE_ASSET_SNAPSHOT, { recursive: true });
      }
    }
    if (command === process.execPath && args.includes('--dry-run')) {
      const output = args[args.indexOf('--outdir') + 1];
      mkdirSync(join(options.cwd, output), { recursive: true });
      writeFileSync(join(options.cwd, output, 'worker.js'), 'bundle');
    }
    if (command === process.execPath && args.includes('list') && args.includes('--json')) {
      return JSON.stringify(deploymentRows ?? [
        { id: 'intended-deployment', created_on: '2026-01-01T00:00:00Z',
          versions: [{ version_id: deploymentVersion }] },
        { id: 'unrelated-newer-deployment', created_on: '2026-12-31T00:00:00Z',
          versions: [{ version_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }] },
      ]);
    }
    return '';
  };
}

function mockConfig(target) {
  return {
    $schema: 'https://example.invalid/config-schema.json',
    name: target.worker,
    assets: target.assets ? { directory: target.assets } : undefined,
    containers: target.worker === 'mainbrella-containers'
      ? [{ class_name: 'UserContainer', images: { terminal: { dockerfile: './containers/Dockerfile' } } }]
      : undefined,
    preserved_setting: 'fixture-value',
    workers_dev: target.worker === 'mainbrella-admin' || target.worker === 'mainbrella-marketing'
      || target.worker === 'mainbrella-containers' ? false : undefined,
    preview_urls: target.worker === 'mainbrella-admin' || target.worker === 'mainbrella-marketing'
      || target.worker === 'mainbrella-containers' ? false : undefined,
  };
}

import { deployBackend, parseArguments as parseBackendArguments } from './deploy.mjs';

test('each registry target publishes once without tests or dry runs', t => {
  for (const name of Object.keys(targets)) {
    const { directory, app, target } = fixture(t, name);
    const log = [];
    const originalConfigPath = join(app, target.config);
    const originalConfig = readFileSync(originalConfigPath, 'utf8');
    const receiptPath = join(directory, 'artifacts/releases', `${name}.wrangler.jsonl`);
    const evidence = withoutConsoleOutput(() => release(name, {
      publish: true,
      directory,
      env: productionEnv,
      run: stubRun(log),
      readConfig: path => {
        assert.equal(path, join(app, target.config));
        return mockConfig(target);
      },
      record: () => {},
    }));

    const npmCalls = log.filter(call => call.command === 'npm');
    assert.deepEqual(npmCalls.map(call => call.args), [
      ...target.preflight.map(script => ['run', script]),
      ['run', target.publish, '--', `--outdir=.wrangler/release-${name}`],
    ], `${name}: preflight and single publish sequence`);
    assert.ok(npmCalls.every(call => call.cwd === app), `${name}: npm runs from its app directory`);
    for (const call of npmCalls) {
      assert.equal(call.env?.WRANGLER_OUTPUT_FILE_PATH,
        call.args[1] === target.publish ? receiptPath : undefined,
        `${name}: receipt output is scoped to its publisher`);
    }
    const publishCalls = npmCalls.filter(call => call.args[1] === target.publish);
    assert.equal(publishCalls.length, 1, `${name}: one scoped publish`);

    assert.equal(log.some(call => call.args.includes('--dry-run')), false, `${name}: skips dry runs`);
    assert.equal(readFileSync(originalConfigPath, 'utf8'), originalConfig, `${name}: source config stays untouched`);
    assert.equal(evidence.target, name);
    assert.equal(evidence.worker, target.worker);
    assert.equal(evidence.sourceSha, sourceSha);
    assert.match(evidence.artifactSha256, /^[a-f0-9]{64}$/);
    assert.equal(evidence.workerVersion, deploymentVersion);
    assert.equal(evidence.deploymentId, 'intended-deployment');
  }
});

test('preflight runs before the target-scoped publish', t => {
  const { directory, target } = fixture(t, 'containers');
  const log = [];
  withoutConsoleOutput(() => release('containers', { publish: true, run: stubRun(log), directory, env: productionEnv,
    readConfig: () => mockConfig(target), record: () => {} }));
  const npmCalls = log.filter(call => call.command === 'npm').map(call => call.args[1]);
  assert.deepEqual(npmCalls, [...target.preflight, target.publish]);
});

test('preflight failures stop before any publish', t => {
  for (const [name, failScript] of [['api', 'api:preflight'], ['admin', 'admin:preflight']]) {
    const { directory, target } = fixture(t, name);
    const log = [];
    const failure = `npm run ${failScript}`;
    assert.throws(() => release(name, { publish: true,
      run: stubRun(log, { failOn: failure }), directory, env: productionEnv,
      readConfig: () => mockConfig(target), record: () => {} }), /stub failed/);
    assert.equal(log.some(call => call.command === 'npm' && call.args[1] === target.publish), false, name);
  }
});

test('arguments reject bare, unknown, duplicate, and unsupported deployment options', () => {
  for (const args of [[], ['unknown'], ['api', '--check', '--execute'], ['api', '--config', 'custom.jsonc']]) {
    assert.throws(() => parseArguments(args));
  }
  assert.deepEqual(parseArguments(['api']), { target: 'api', mode: 'dispatch' });
  assert.deepEqual(parseArguments(['api', '--check']), { target: 'api', mode: 'check' });
  assert.deepEqual(parseArguments(['api', '--local']), { target: 'api', mode: 'local' });
  assert.deepEqual(parseArguments(['api', '--execute']), { target: 'api', mode: 'execute' });
  for (const args of [['api', '--local', '--check'], ['api', '--local', '--execute'], ['api', '--local', '--local']]) assert.throws(() => parseArguments(args));
});

test('local releases publish the checkout directly using Wrangler login and retain release evidence', t => {
  for (const name of Object.keys(targets)) {
    const { directory, app, target } = fixture(t, name);
    const calls = [], env = { SAFE: 'yes' }, recorded = [];
    const evidence = withoutConsoleOutput(() => release(name, { publish: true, local: true,
      directory, env, run: stubRun(calls, { status: ' M scripts/deploy.mjs' }),
      readConfig: () => ({ ...mockConfig(target), account_id: 'a'.repeat(32) }),
      record: (path, content) => recorded.push({ path, content }),
    }));
    assert.equal(calls.some(call => call.command === 'gh' || call.command === 'git' && ['fetch', 'merge-base', 'remote'].includes(call.args[0])), false);
    const auth = calls.filter(call => call.args.includes('auth'));
    assert.equal(auth.length, 1);
    assert.equal(auth[0].cwd, app);
    assert.deepEqual(auth[0].args.slice(1), ['auth', 'token', '--json']);
    assert.deepEqual(auth[0].env, { SAFE: 'yes', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), WRANGLER_WRITE_LOGS: 'false' });
    assert.deepEqual(env, { SAFE: 'yes' });
    const npmCalls = calls.filter(call => call.command === 'npm');
    assert.deepEqual(npmCalls.map(call => call.args[1]), [...target.preflight, target.publish]);
    assert.ok(npmCalls.every(call => call.env.CLOUDFLARE_API_TOKEN === 'private-local-test-token'));
    assert.equal(evidence.local, true);
    assert.equal(evidence.sourceDirty, true);
    assert.equal(evidence.sourceSha, sourceSha);
    assert.equal(evidence.workerVersion, deploymentVersion);
    assert.match(evidence.artifactSha256, /^[a-f0-9]{64}$/);
    assert.ok(recorded.every(item => !item.content.includes('private-local-test-token')));
  }
});

test('backend deploy defaults to direct API publication and rejects unsupported options', () => {
  assert.deepEqual(parseBackendArguments([]), { mode: 'publish' });
  assert.deepEqual(parseBackendArguments(['--check']), { mode: 'check' });
  assert.deepEqual(parseBackendArguments(['--help']), { mode: 'help' });
  for (const args of [['api'], ['--force'], ['--check', '--local']]) assert.throws(() => parseBackendArguments(args), /Usage:/);
});

test('backend npm deploy authenticates once, migrates before preflight, and publishes only the API', t => {
  const { directory, app } = fixture(t, 'api');
  const calls = [], env = { SAFE: 'yes' };
  const evidence = withoutConsoleOutput(() => deployBackend({ directory, env, run: stubRun(calls) }));
  assert.deepEqual(calls.filter(call => call.command === 'npm').map(call => call.args), [
    ['run', 'db:migrate:remote'],
    ['run', 'api:preflight'],
    ['run', 'deploy:api', '--', '--outdir=.wrangler/release-api'],
  ]);
  assert.equal(calls.filter(call => call.args.includes('auth')).length, 1);
  assert.equal(calls.some(call => call.command === 'gh' || call.command === 'git' && ['fetch', 'merge-base', 'remote'].includes(call.args[0])), false);
  assert.ok(calls.filter(call => call.command === 'npm').every(call => call.cwd === app && call.env.CLOUDFLARE_API_TOKEN === 'private-local-test-token'));
  assert.equal(evidence.target, 'api');
  assert.equal(evidence.local, true);
  assert.equal(evidence.workerVersion, deploymentVersion);
  assert.deepEqual(env, { SAFE: 'yes' });
  assert.ok(!readFileSync(join(directory, 'artifacts/releases/api.json'), 'utf8').includes('private-local-test-token'));
});

test('backend credential and migration failures stop before publication', t => {
  const { directory } = fixture(t, 'api');
  const authCalls = [];
  assert.throws(() => deployBackend({ directory, env: {}, run: stubRun(authCalls, { credential: { type: 'oauth', token: '' } }) }), /credentials are unavailable/);
  assert.equal(authCalls.some(call => call.command === 'npm'), false);
  const migrationCalls = [];
  assert.throws(() => deployBackend({ directory, env: {}, run: stubRun(migrationCalls, {
    failOn: 'npm run db:migrate:remote',
  }) }), /stub failed/);
  assert.deepEqual(migrationCalls.filter(call => call.command === 'npm').map(call => call.args[1]), ['db:migrate:remote']);
});

test('backend deploy --check never reads credentials, migrates, or publishes', t => {
  const { directory, target } = fixture(t, 'api');
  const calls = [];
  deployBackend({ publish: false, directory, env: {}, run: stubRun(calls) });
  assert.deepEqual(calls.filter(call => call.command === 'npm').map(call => call.args[1]), target.checks);
  assert.ok(calls.some(call => call.args.includes('--dry-run')));
  assert.equal(calls.some(call => call.args.includes('auth') || call.args.includes('db:migrate:remote') || call.args.includes('deploy:api')), false);
});

test('local releases reuse explicit credentials and reject mismatched accounts before reading credentials', t => {
  const { directory, target } = fixture(t, 'api');
  const calls = [], env = { CLOUDFLARE_API_TOKEN: 'explicit-test-token' };
  const evidence = withoutConsoleOutput(() => release('api', { publish: true, local: true,
    directory, env, run: stubRun(calls), readConfig: () => mockConfig(target), record: () => {},
  }));
  assert.equal(calls.some(call => call.args.includes('auth')), false);
  assert.equal(calls.find(call => call.command === 'npm').env.CLOUDFLARE_API_TOKEN, env.CLOUDFLARE_API_TOKEN);
  assert.equal(evidence.sourceDirty, false);
  for (const key of ['CLOUDFLARE_ACCOUNT_ID', 'CF_ACCOUNT_ID']) {
    const rejected = [];
    assert.throws(() => release('api', { publish: true, local: true, directory, env: { [key]: 'wrong-account' },
      run: stubRun(rejected), readConfig: () => ({ ...mockConfig(target), account_id: 'a'.repeat(32) }),
    }), /differs from the configured deployment account/);
    assert.deepEqual(rejected, []);
  }
});

test('failed local credentials and preflights stop publication without exposing credentials', t => {
  const { directory, target } = fixture(t, 'api');
  for (const credential of [{ type: 'global_key', token: 'private-rejected-token' }, { type: 'oauth', token: '' }]) {
    const calls = [];
    assert.throws(() => release('api', { publish: true, local: true, directory, env: {},
      run: stubRun(calls, { credential }), readConfig: () => mockConfig(target),
    }), error => error.message.includes('Cloudflare credentials are unavailable') && !error.message.includes('private-rejected-token'));
    assert.equal(calls.some(call => call.command === 'npm'), false);
  }
  const calls = [];
  assert.throws(() => release('api', { publish: true, local: true, directory, env: {},
    run: stubRun(calls, { failOn: `npm run api:preflight` }),
    readConfig: () => mockConfig(target),
  }), /stub failed/);
  assert.equal(calls.some(call => call.command === 'npm' && call.args[1] === target.publish), false);
});

test('--check runs checks and bundle dry-run without remote preflight or publishing', t => {
  const { directory, target } = fixture(t, 'containers');
  const log = [];
  withoutConsoleOutput(() => release('containers', { publish: false, run: stubRun(log), directory, env: {},
    readConfig: () => mockConfig(target), record: () => {} }));
  const npmCalls = log.filter(call => call.command === 'npm').map(call => call.args[1]);
  assert.deepEqual(npmCalls, target.checks);
  assert.ok(log.some(call => call.args.includes('--dry-run')));
  assert.equal(log.some(call => call.args[1]?.includes('preflight')), false);
  assert.equal(log.some(call => call.command === 'npm' && call.args[1] === target.publish), false);
});

test('containers temporary bundle config is removed after Wrangler failure', t => {
  const { directory, app, target } = fixture(t, 'containers');
  const originalConfigPath = join(app, target.config);
  const originalConfig = readFileSync(originalConfigPath, 'utf8');
  const temporaryConfig = join(app, `.wrangler-local-bundle-${process.pid}.jsonc`);
  const log = [];
  assert.throws(() => release('containers', { publish: false,
    run: stubRun(log, { onCall: call => {
      if (!call.args.includes('--dry-run')) return;
      assert.equal(call.args[call.args.indexOf('--config') + 1], temporaryConfig.split('/').at(-1));
      const bundled = JSON.parse(readFileSync(temporaryConfig, 'utf8'));
      assert.equal('containers' in bundled, false);
      throw new Error('stub Wrangler failure');
    } }), directory, env: {}, readConfig: () => mockConfig(target) }), /stub Wrangler failure/);
  assert.equal(existsSync(temporaryConfig), false);
  assert.equal(readFileSync(originalConfigPath, 'utf8'), originalConfig);
});

test('malformed, unexpected, or multiple publisher receipts stop before deployment lookup', t => {
  const cases = [
    ['malformed JSONL', '{not-json\n', /JSON/],
    ['unexpected worker', JSON.stringify({ type: 'deploy', worker_name: 'other-worker', version_id: deploymentVersion }) + '\n', /exactly one selected worker version/],
    ['multiple deploy receipts', [
      { type: 'deploy', worker_name: targetFor('api').worker, version_id: deploymentVersion },
      { type: 'deploy', worker_name: targetFor('api').worker, version_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
    ].map(JSON.stringify).join('\n') + '\n', /exactly one selected worker version/],
  ];
  for (const [label, publicationContent, expectedError] of cases) {
    const { directory, target } = fixture(t, 'api');
    const log = [];
    assert.throws(() => release('api', { publish: true,
      run: stubRun(log, { publicationContent }), directory, env: productionEnv,
      readConfig: () => mockConfig(target), record: () => {} }), expectedError, label);
    assert.equal(log.some(call => call.command === process.execPath && call.args.includes('list')),
      false, `${label}: does not query unrelated deployment records`);
  }
});


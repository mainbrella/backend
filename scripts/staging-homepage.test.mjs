import { stagingTestRoot } from './staging-test-fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { artifactHash } from './release.mjs';
import { parseArguments, publishStagingHomepage } from './staging-homepage.mjs';
import { STAGING, stagingConfig } from './staging-config.mjs';

const sourceRoot = stagingTestRoot();
const sourceSha = 'a'.repeat(40);
const workerVersion = '12345678-1234-1234-1234-123456789abc';
const operationId = 'homepage-test-id';

function fixture(t) {
  const temporary = mkdtempSync(join(tmpdir(), 'canopy-stage-homepage-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const directory = join(temporary, 'backend');
  mkdirSync(directory, { recursive: true });
  const app = join(directory, '../web');
  mkdirSync(app, { recursive: true });
  mkdirSync(join(directory, '.'), { recursive: true });
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: '@canopy/web' }));
  writeFileSync(join(app, 'wrangler.jsonc'), readFileSync(join(sourceRoot, '../web/wrangler.jsonc')));
  writeFileSync(join(directory, 'wrangler.jsonc'), readFileSync(join(sourceRoot, 'wrangler.jsonc')));
  const wrangler = join(app, 'node_modules/wrangler');
  mkdirSync(join(wrangler, 'bin'), { recursive: true });
  writeFileSync(join(wrangler, 'package.json'), JSON.stringify({ name: 'wrangler', version: '0.0.0' }));
  writeFileSync(join(wrangler, 'bin/wrangler.js'), '');
  return { directory, app };
}

function stubRun(fixture, { dirty = '', accountId = STAGING.accountId, receipt = null, failPublish = false,
  mutateConfigAtWhoami = false } = {}) {
  const calls = [];
  let configPath;
  let configuration;
  let directoryHash;
  return {
    calls,
    get configPath() { return configPath; },
    get configuration() { return configuration; },
    get directoryHash() { return directoryHash; },
    run(command, args, options = {}) {
      calls.push({ command, args, options });
      if (command === 'git' && args[0] === 'status') return dirty;
      if (command === 'git' && args[0] === 'rev-parse') return sourceSha;
      if (command === 'git' && args[0] === 'remote') return options.cwd === fixture.app ? 'git@github.com:mainbrella/web.git' : 'git@github.com:mainbrella/backend.git';
      if (command === 'npm' && ['docs:check', 'test'].includes(args[1])) return '';
      if (command === 'npm' && args[1] === 'build:site:staging') {
        mkdirSync(join(fixture.app, 'dist'), { recursive: true });
        writeFileSync(join(fixture.app, 'dist/index.html'), '<main>staging homepage</main>');
        return '';
      }
      if (command === process.execPath && args.includes('deploy')) {
        configPath = args[args.indexOf('--config') + 1];
        assert.ok(configPath.startsWith(fixture.app + '/wrangler.staging-homepage-'));
        configuration = JSON.parse(readFileSync(configPath, 'utf8'));
        assert.equal(configuration.name, 'mainbrella-web-stg');
        assert.equal(configuration.account_id, STAGING.accountId);
        assert.equal(configuration.routes[0].pattern, 'stg.mainbrella.com');
        assert.equal(configuration.assets.directory, './dist');
        assert.equal(configuration.d1_databases, undefined);
        assert.equal(configuration.r2_buckets, undefined);
        const outputDirectory = args[args.indexOf('--outdir') + 1];
        mkdirSync(outputDirectory, { recursive: true });
        writeFileSync(join(outputDirectory, 'worker.js'), 'staging worker bundle');
        directoryHash = artifactHash([outputDirectory, join(fixture.app, 'dist')]);
        if (args.includes('--dry-run')) return '';
      }
      if (command === process.execPath && args.includes('whoami')) {
        configPath = join(fixture.app, `wrangler.staging-homepage-${operationId}.jsonc`);
        configuration = JSON.parse(readFileSync(configPath, 'utf8'));
        if (mutateConfigAtWhoami) writeFileSync(configPath, JSON.stringify({ ...configuration, name: 'mainbrella-web' }));
        return JSON.stringify({ accounts: [{ id: accountId, name: 'test account' }] });
      }
      if (command === process.execPath && args.includes('deploy')) {
        const config = JSON.parse(readFileSync(args[args.indexOf('--config') + 1], 'utf8'));
        assert.equal(config.name, 'mainbrella-web-stg');
        assert.ok(options.env.WRANGLER_OUTPUT_FILE_PATH);
        const rows = receipt ?? [{ type: 'deploy', worker_name: 'mainbrella-web-stg', version_id: workerVersion }];
        writeFileSync(options.env.WRANGLER_OUTPUT_FILE_PATH, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
        if (failPublish) throw new Error('simulated deploy transport failure');
        return 'staging publish output';
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    },
  };
}

test('only explicit check or publish modes are accepted', () => {
  assert.deepEqual(parseArguments(['--check']), { publish: false });
  assert.deepEqual(parseArguments(['--publish']), { publish: true });
  for (const args of [[], ['--force'], ['--publish', '--check']]) assert.throws(() => parseArguments(args), /Usage:/);
});

test('offline check forces staging frontend settings and never checks identity or publishes', t => {
  const f = fixture(t);
  const stub = stubRun(f);
  const output = [];
  const evidence = publishStagingHomepage({ directory: f.directory, run: stub.run, log: value => output.push(value), id: () => operationId,
    env: { VITE_API_URL: 'https://api.mainbrella.com', VITE_GA_MEASUREMENT_ID: 'G-PRODUCTION' } });
  assert.equal(evidence.status, 'checked');
  assert.equal(evidence.sourceSha, sourceSha);
  assert.match(evidence.artifactSha256, /^[a-f0-9]{64}$/);
  const expectedConfiguration = stagingConfig('site', { resources: {
    databaseId: '00000000-0000-4000-8000-000000000001',
    previewDatabaseId: '00000000-0000-4000-8000-000000000002',
    bucketName: STAGING.bucketName,
  }, directory: f.directory });
  const expectedHash = createHash('sha256').update(stub.directoryHash).update('\0')
    .update(JSON.stringify(expectedConfiguration)).digest('hex');
  assert.equal(evidence.artifactSha256, expectedHash);
  const docs = stub.calls.find(call => call.command === 'npm' && call.args[1] === 'docs:check');
  const build = stub.calls.find(call => call.command === 'npm' && call.args[1] === 'build:site:staging');
  assert.ok(docs && build);
  assert.equal(build.options.env.VITE_API_URL, STAGING.apiOrigin);
  assert.equal(build.options.env.VITE_GA_MEASUREMENT_ID, '');
  assert.equal(build.options.env.VITE_GOOGLE_CLIENT_ID, '854186419005-l0u2olqlqe40qmgin0q8tjpvftooi6ac.apps.googleusercontent.com');
  assert.equal(stub.calls.some(call => call.command === process.execPath && call.args.includes('whoami')), false);
  assert.equal(stub.calls.some(call => call.command === process.execPath && call.args.includes('deploy') && !call.args.includes('--dry-run')), false);
  assert.equal(existsSync(join(f.app, 'wrangler.staging-homepage-' + operationId + '.jsonc')), false);
  assert.equal(existsSync(join(f.directory, 'artifacts/staging', 'homepage-' + operationId, 'homepage.json')), true);
  assert.equal(JSON.parse(output[0]).status, 'checked');
  assert.deepEqual(stub.calls.filter(call => call.command === 'npm').map(call => call.args[1]), ['docs:check', 'test', 'build:site:staging']);
});

test('publish requires a clean committed official backend repository source before writing temporary files', t => {
  const f = fixture(t);
  const stub = stubRun(f, { dirty: ' M apps/web/index.html' });
  assert.throws(() => publishStagingHomepage({ publish: true, directory: f.directory, run: stub.run, id: () => operationId }), /clean committed backend repository/);
  assert.deepEqual(stub.calls.map(call => [call.command, call.args]), [['git', ['status', '--porcelain']]]);
  assert.equal(existsSync(join(f.app, 'wrangler.staging-homepage-' + operationId + '.jsonc')), false);
  assert.equal(existsSync(join(f.directory, 'artifacts/staging')), false);
});

test('publish checks exact staging-account identity and preserves failure evidence without publishing', t => {
  const f = fixture(t);
  const stub = stubRun(f, { accountId: '00000000000000000000000000000000' });
  assert.throws(() => publishStagingHomepage({ publish: true, directory: f.directory, run: stub.run, id: () => operationId }), /does not select staging account/);
  assert.equal(stub.calls.some(call => call.command === process.execPath && call.args.includes('deploy') && !call.args.includes('--dry-run')), false);
  const evidencePath = join(f.directory, 'artifacts/staging/homepage-' + operationId + '/homepage.json');
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
  assert.equal(evidence.status, 'failed');
  assert.equal(evidence.failedAt, 'wrangler-account-check');
  assert.equal(existsSync(join(f.app, 'wrangler.staging-homepage-' + operationId + '.jsonc')), false);
});

test('publish revalidates the on-disk stage config immediately before deploy', t => {
  const f = fixture(t);
  const stub = stubRun(f, { mutateConfigAtWhoami: true });
  assert.throws(() => publishStagingHomepage({ publish: true, directory: f.directory, run: stub.run, id: () => operationId, log: () => {} }), /Unsafe or unexpected site staging configuration/);
  assert.equal(stub.calls.some(call => call.command === process.execPath && call.args.includes('deploy') && !call.args.includes('--dry-run')), false);
  const evidence = JSON.parse(readFileSync(join(f.directory, 'artifacts/staging/homepage-' + operationId + '/homepage.json'), 'utf8'));
  assert.equal(evidence.failedAt, 'wrangler-publish');
});

test('publish records the exact staging worker version and retains raw receipt on invalid receipt', t => {
  const f = fixture(t);
  const stub = stubRun(f, { receipt: [{ type: 'deploy', worker_name: 'mainbrella-api-stg', version_id: workerVersion }] });
  assert.throws(() => publishStagingHomepage({ publish: true, directory: f.directory, run: stub.run, id: () => operationId, log: () => {} }), /exactly one version for the staging homepage worker/);
  const artifact = join(f.directory, 'artifacts/staging/homepage-' + operationId);
  const evidence = JSON.parse(readFileSync(join(artifact, 'homepage.json'), 'utf8'));
  assert.equal(evidence.failedAt, 'wrangler-publish');
  assert.match(readFileSync(join(artifact, 'homepage.wrangler.jsonl'), 'utf8'), /mainbrella-api-stg/);
  assert.equal(existsSync(join(f.app, 'wrangler.staging-homepage-' + operationId + '.jsonc')), false);
});

test('publish preserves partial Wrangler receipt and evidence when the publish command fails', t => {
  const f = fixture(t);
  const stub = stubRun(f, { failPublish: true });
  assert.throws(() => publishStagingHomepage({ publish: true, directory: f.directory, run: stub.run, id: () => operationId, log: () => {} }), /simulated deploy transport failure/);
  const artifact = join(f.directory, 'artifacts/staging/homepage-' + operationId);
  const evidence = JSON.parse(readFileSync(join(artifact, 'homepage.json'), 'utf8'));
  assert.equal(evidence.status, 'failed');
  assert.equal(evidence.failedAt, 'wrangler-publish');
  assert.match(readFileSync(join(artifact, 'homepage.wrangler.jsonl'), 'utf8'), /mainbrella-web-stg/);
});

test('successful explicit publish builds once and records the receipt without tests or dry runs', t => {
  const f = fixture(t);
  const stub = stubRun(f);
  const evidence = publishStagingHomepage({ publish: true, directory: f.directory, run: stub.run, id: () => operationId, log: () => {} });
  assert.equal(evidence.status, 'published');
  assert.equal(evidence.workerVersion, workerVersion);
  assert.equal(stub.calls.some(call => call.args.includes('--dry-run')), false);
  assert.deepEqual(stub.calls.filter(call => call.command === 'npm').map(call => call.args[1]), ['build:site:staging']);
  assert.equal(stub.calls.findIndex(call => call.command === process.execPath && call.args.includes('whoami'))
    < stub.calls.findIndex(call => call.command === process.execPath && call.args.includes('deploy')), true);
  const publishCall = stub.calls.find(call => call.command === process.execPath && call.args.includes('deploy') && !call.args.includes('--dry-run'));
  assert.ok(publishCall);
  assert.equal(publishCall.options.stdio, 'inherit');
  assert.equal(publishCall.options.env.VITE_API_URL, STAGING.apiOrigin);
  assert.equal(publishCall.options.env.VITE_GA_MEASUREMENT_ID, '');
  const recorded = JSON.parse(readFileSync(join(f.directory, 'artifacts/staging/homepage-' + operationId + '/homepage.json'), 'utf8'));
  assert.equal(recorded.workerVersion, workerVersion);
});

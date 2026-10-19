import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backendOperation, parseWranglerDeploys, validateOperation } from './backend-operation.mjs';
import { targetFor } from './staging-targets.mjs';

const sha = 'a'.repeat(40);
const env = {
  GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'mainbrella/backend',
  GITHUB_WORKFLOW_REF: 'mainbrella/backend/.github/workflows/backend-operations.yml@refs/heads/main',
  RELEASE_SHA: sha,
};
const version = number => `12345678-1234-1234-1234-${String(number).padStart(12, '0')}`;
const event = (name, number) => JSON.stringify({ type: 'deploy', version: 1,
  worker_name: targetFor(name).worker, version_id: version(number), timestamp: '2026-10-16T00:00:00Z' }) + '\n';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'canopy-backend-operation-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'migrations'), { recursive: true });
  mkdirSync(join(directory, 'preview-migrations'), { recursive: true });
  writeFileSync(join(directory, 'migrations/001.sql'), 'CREATE TABLE account (id TEXT);\n');
  writeFileSync(join(directory, 'preview-migrations/001.sql'), 'CREATE TABLE route (id TEXT);\n');
  const calls = [];
  let output = '';
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'git') return sha;
    assert.equal(command, 'npm');
    output = options.env.WRANGLER_OUTPUT_FILE_PATH;
    return '';
  };
  const evidence = operation => JSON.parse(readFileSync(join(directory,
    `artifacts/releases/backend-${operation}-${sha}.json`), 'utf8'));
  return { directory, calls, run, evidence,
    get output() { return output; } };
}

test('workflow identity, operation allowlist, and exact source SHA gate execution', () => {
  validateOperation('release', env, sha);
  for (const operation of ['deploy-all', '', 'release:api']) assert.throws(() => validateOperation(operation, env, sha));
  for (const change of [
    { GITHUB_ACTIONS: 'false' }, { GITHUB_REPOSITORY: 'mainbrella/other' },
    { GITHUB_WORKFLOW_REF: 'mainbrella/backend/.github/workflows/deploy.yml@refs/heads/main' },
    { RELEASE_SHA: 'b'.repeat(40) },
  ]) assert.throws(() => validateOperation('release', { ...env, ...change }, sha));
});

test('Wrangler output ignores dry runs and preserves valid entries around malformed lines', () => {
  const result = parseWranglerDeploys(`${event('api', 1)}not-json\n${JSON.stringify({ type: 'deploy', version: 1,
    worker_name: 'mainbrella-api', version_id: null })}\n${event('admin', 2)}`);
  assert.deepEqual(result.records.map(item => item.worker), ['mainbrella-api', 'mainbrella-admin']);
  assert.equal(result.errors.length, 1);
});

test('coordinated release records each published Worker without validation builds', t => {
  const f = fixture(t);
  const sequence = ['containers', 'previews', 'admin', 'marketing', 'api'];
  const run = (command, args, options) => {
    const result = f.run(command, args, options);
    if (command === 'npm') writeFileSync(f.output, sequence.map((name, index) => event(name, index + 1)).join(''));
    return result;
  };
  const result = backendOperation('release', { directory: f.directory, env, run, log: () => {} });
  assert.equal(result.status, 'success');
  assert.deepEqual(result.publications.map(item => item.target), sequence);
  assert.equal(result.publications[4].workerVersion, version(5));
  assert.equal(result.publications.every(item => item.sourceSha === sha), true);
  assert.deepEqual(f.calls.map(call => call.command), ['git', 'npm']);
  assert.equal(f.calls[1].options.cwd, join(f.directory, '.'));
  assert.deepEqual(f.calls[1].args, ['run', 'deploy:all']);
  assert.deepEqual(f.evidence('release').publications, result.publications);
});

test('bootstrap records both container publications in their actual order', t => {
  const f = fixture(t);
  const sequence = ['containers', 'admin', 'marketing', 'api', 'containers', 'previews'];
  const run = (command, args, options) => {
    const result = f.run(command, args, options);
    if (command === 'npm') writeFileSync(f.output, sequence.map((name, index) => event(name, index + 1)).join(''));
    return result;
  };
  const result = backendOperation('bootstrap-activity', { directory: f.directory, env, run, log: () => {} });
  assert.deepEqual(result.publications.map(item => item.target), sequence);
  assert.equal(result.publications[0].workerVersion, version(1));
  assert.equal(result.publications[4].workerVersion, version(5));
  assert.deepEqual(f.calls.map(call => call.command), ['git', 'npm']);
});

test('partial failure still writes all observed publications and marks the remainder unconfirmed', t => {
  const f = fixture(t);
  const run = (command, args, options) => {
    if (command === 'npm') {
      f.run(command, args, options);
      appendFileSync(f.output, event('containers', 1) + event('previews', 2));
      throw new Error('simulated operation failure');
    }
    return f.run(command, args, options);
  };
  assert.throws(() => backendOperation('release', { directory: f.directory, env, run, log: () => {} }),
    /simulated operation failure/);
  const result = f.evidence('release');
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.publications.map(item => item.target), ['containers', 'previews']);
  assert.equal(result.remainingPublicationsUnconfirmed, true);
});

test('unexpected or missing Wrangler records fail while preserving raw output', t => {
  for (const [label, output] of [
    ['missing', event('containers', 1)],
    ['unexpected', event('api', 1)],
    ['malformed', event('containers', 1) + 'not-json\n'],
  ]) {
    const f = fixture(t);
    const run = (command, args, options) => {
      const result = f.run(command, args, options);
      if (command === 'npm') writeFileSync(f.output, output);
      return result;
    };
    assert.throws(() => backendOperation('release', { directory: f.directory, env, run, log: () => {} }), label);
    assert.equal(f.evidence('release').status, 'failed');
    assert.ok(f.evidence('release').publications.length);
    assert.equal(readFileSync(f.output, 'utf8'), output);
  }
});

test('migration evidence hashes selected SQL inputs and claims no Worker version', t => {
  for (const operation of ['migrate-api', 'migrate-previews']) {
    const f = fixture(t);
    const result = backendOperation(operation, { directory: f.directory, env, run: f.run, log: () => {} });
    assert.equal(result.status, 'success');
    assert.match(result.migrationSourceSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(result.publications, []);
    assert.match(f.calls[1].options.env.WRANGLER_OUTPUT_FILE_PATH, /wrangler-migrate-/);
    assert.equal(Object.hasOwn(result, 'workerVersion'), false);
    assert.equal(f.calls[1].options.cwd, join(f.directory, '.'));
  }
});

test('a migration that unexpectedly emits a Worker deployment fails and records it', t => {
  const f = fixture(t);
  const run = (command, args, options) => {
    const result = f.run(command, args, options);
    if (command === 'npm') writeFileSync(f.output, event('api', 1));
    return result;
  };
  assert.throws(() => backendOperation('migrate-api', { directory: f.directory, env, run, log: () => {} }),
    /Unexpected Worker publication/);
  const result = f.evidence('migrate-api');
  assert.equal(result.status, 'failed');
  assert.equal(result.publications[0].worker, 'mainbrella-api');
  assert.equal(result.publications[0].workerVersion, version(1));
});

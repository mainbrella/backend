import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { artifactHash } from './release.mjs';
import { STAGING, assertStagingConfig, stagingConfig } from './staging-config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const SITE_WORKER = 'mainbrella-web-stg';
const RESOURCES = Object.freeze({
  databaseId: '00000000-0000-4000-8000-000000000001',
  previewDatabaseId: '00000000-0000-4000-8000-000000000002',
  bucketName: STAGING.bucketName,
});
const VERSION_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

function execute(command, args, options = {}) {
  return execFileSync(command, args, { stdio: 'inherit', ...options });
}

function capture(run, command, args, options) {
  return String(run(command, args, { ...options, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) ?? '').trim();
}

function gitSource({ run, directory, publish, repository = 'backend' }) {
  const options = { cwd: directory };
  const status = capture(run, 'git', ['status', '--porcelain'], options);
  if (publish && status) throw new Error('Publish requires a clean committed backend repository source tree.');
  const sourceSha = capture(run, 'git', ['rev-parse', 'HEAD'], options);
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('Cannot identify the selected source commit.');
  if (publish) {
    const remote = capture(run, 'git', ['remote', 'get-url', 'origin'], options);
    if (![
      `git@github.com:mainbrella/${repository}.git`, `https://github.com/mainbrella/${repository}.git`,
      `https://github.com/mainbrella/${repository}`,
    ].includes(remote)) throw new Error(`Publish requires origin to be mainbrella/${repository}.`);
  }
  return { sourceSha, dirty: Boolean(status) };
}

function stagingSiteConfig(directory, googleClientId) {
  const apiConfiguration = stagingConfig('api', { resources: RESOURCES, directory, googleClientId });
  const effectiveGoogleClientId = apiConfiguration.vars?.GOOGLE_CLIENT_ID;
  const configuration = stagingConfig('site', { resources: RESOURCES, directory });
  assertStagingConfig('site', configuration, { resources: RESOURCES, directory });
  return { configuration, googleClientId: effectiveGoogleClientId };
}

function parseReceipt(path, worker) {
  let entries;
  try {
    entries = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch {
    throw new Error('Wrangler did not produce a valid deployment receipt. Review the preserved raw receipt before retrying.');
  }
  const versions = entries.filter(entry => entry?.type === 'deploy' && entry.version_id);
  if (versions.length !== 1 || versions[0].worker_name !== worker || !VERSION_ID.test(versions[0].version_id)) {
    throw new Error('Wrangler did not report exactly one version for the staging homepage worker. Review the preserved raw receipt before retrying.');
  }
  return versions[0].version_id;
}

function accountMatches(payload, expectedAccountId) {
  if (!payload || typeof payload !== 'object') return false;
  if (payload.account_id === expectedAccountId || payload.accountId === expectedAccountId
    || payload.account?.id === expectedAccountId) return true;
  return Array.isArray(payload.accounts) && payload.accounts.some(account => account?.id === expectedAccountId);
}

function validatedHash(directories, configuration) {
  return createHash('sha256').update(artifactHash(directories)).update('\0')
    .update(JSON.stringify(configuration)).digest('hex');
}

function requireStageAccount(stdout) {
  let payload;
  try { payload = JSON.parse(stdout); } catch {
    throw new Error('Wrangler account check returned invalid JSON; staging homepage publish was stopped.');
  }
  if (!accountMatches(payload, STAGING.accountId)) {
    throw new Error(`Wrangler authentication does not select staging account ${STAGING.accountId}; homepage publish was stopped.`);
  }
}

export function parseArguments(args) {
  if (args.length === 1 && args[0] === '--check') return { publish: false };
  if (args.length === 1 && args[0] === '--publish') return { publish: true };
  throw new Error('Usage: node scripts/staging-homepage.mjs --check | --publish');
}

export function publishStagingHomepage({ publish = false, directory = root, env = process.env,
  run = execute, log = console.log, id = randomUUID } = {}) {
  const appDirectory = join(directory, '../web');
  const backendSource = gitSource({ run, directory, publish });
  const { sourceSha, dirty } = gitSource({ run, directory: appDirectory, publish, repository: 'web' });
  const operationId = id();
  const evidenceDirectory = join(directory, 'artifacts/staging', `homepage-${operationId}`);
  const bundleDirectory = join(appDirectory, '.wrangler', `staging-homepage-${operationId}`);
  const configPath = join(appDirectory, `wrangler.staging-homepage-${operationId}.jsonc`);
  const receiptPath = join(evidenceDirectory, 'homepage.wrangler.jsonl');
  const evidencePath = join(evidenceDirectory, 'homepage.json');
  const googleClientId = env.STAGING_GOOGLE_CLIENT_ID;
  const { configuration, googleClientId: effectiveGoogleClientId } = stagingSiteConfig(directory, googleClientId);
  const configText = JSON.stringify(configuration, null, 2) + '\n';
  const buildEnv = {
    ...env,
    VITE_API_URL: STAGING.apiOrigin,
    VITE_GA_MEASUREMENT_ID: '',
    ...(effectiveGoogleClientId ? { VITE_GOOGLE_CLIENT_ID: effectiveGoogleClientId } : {}),
  };
  const evidence = {
    sourceSha,
    backendSourceSha: backendSource.sourceSha,
    target: 'site',
    worker: SITE_WORKER,
    environment: 'staging',
    status: 'running',
    worktreeDirty: dirty,
    startedAt: new Date().toISOString(),
  };
  let step = 'prepare';
  let wrangler;

  function record() {
    mkdirSync(evidenceDirectory, { recursive: true });
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
  }

  try {
    record();
    if (!publish) {
      step = 'docs-check';
      run('npm', ['run', 'docs:check'], { cwd: appDirectory, env: buildEnv });

      step = 'web-tests';
      run('npm', ['run', 'test'], { cwd: appDirectory, env: buildEnv });
    }

    step = 'staging-site-build';
    run('npm', ['run', 'build:site:staging'], { cwd: appDirectory, env: buildEnv });

    step = 'prepare-wrangler';
    const require = createRequire(join(appDirectory, 'package.json'));
    wrangler = join(dirname(require.resolve('wrangler/package.json')), 'bin/wrangler.js');
    writeFileSync(configPath, configText);

    rmSync(bundleDirectory, { recursive: true, force: true });
    if (!publish) {
      step = 'wrangler-dry-run';
      run(process.execPath, [wrangler, 'deploy', '--dry-run', '--config', configPath, '--outdir', bundleDirectory], {
        cwd: appDirectory, env: buildEnv,
      });
      evidence.artifactSha256 = validatedHash([bundleDirectory, join(appDirectory, 'dist')], configuration);
      evidence.status = 'checked';
      evidence.completedAt = new Date().toISOString();
      record();
      log(JSON.stringify(evidence, null, 2));
      return evidence;
    }

    step = 'wrangler-account-check';
    const identity = capture(run, process.execPath, [wrangler, 'whoami', '--json'], { cwd: appDirectory, env });
    requireStageAccount(identity);

    step = 'wrangler-publish';
    const freshConfiguration = JSON.parse(readFileSync(configPath, 'utf8'));
    assertStagingConfig('site', freshConfiguration, { resources: RESOURCES, directory });
    const publishEnv = { ...buildEnv, WRANGLER_OUTPUT_FILE_PATH: receiptPath };
    const output = run(process.execPath, [wrangler, 'deploy', '--config', configPath, '--outdir', bundleDirectory], {
      cwd: appDirectory, env: publishEnv, stdio: 'inherit',
    });
    if (output) log(String(output).trim());
    evidence.artifactSha256 = validatedHash([bundleDirectory, join(appDirectory, 'dist')], configuration);
    evidence.workerVersion = parseReceipt(receiptPath, SITE_WORKER);
    evidence.status = 'published';
    evidence.completedAt = new Date().toISOString();
    record();
    log(JSON.stringify(evidence, null, 2));
    return evidence;
  } catch (error) {
    evidence.status = 'failed';
    evidence.failedAt = step;
    evidence.failedAtTime = new Date().toISOString();
    evidence.error = error.status ? 'Command failed; inspect its output and any preserved Wrangler receipt.' : error.message;
    try { record(); } catch { /* Preserve the original failure if evidence storage is unavailable. */ }
    throw error;
  } finally {
    rmSync(configPath, { force: true });
    rmSync(bundleDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { publish } = parseArguments(process.argv.slice(2));
    publishStagingHomepage({ publish });
  } catch (error) {
    console.error(error.status ? 'Staging homepage command failed. Review the preceding output and preserved evidence before retrying.' : error.message);
    process.exitCode = 1;
  }
}

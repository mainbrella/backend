import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { artifactHash } from './release.mjs';
import { targetFor } from './staging-targets.mjs';
import { STAGING, assertStagingConfig, stagingConfig } from './staging-config.mjs';
import { provisionStaging } from './staging-resources.mjs';
import { preflightStaging } from './staging-preflight.mjs';
import { checkWorkerBoundary } from './check-worker-boundaries.mjs';
import { validateImage } from './terminal-image.mjs';
import { validateCatalogImages } from './catalog-images.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export const stagingTargets = ['api', 'admin', 'marketing', 'containers', 'previews', 'site', 'builder', 'raindrop'];
export const stagingBackendTargets = ['api', 'admin', 'marketing', 'containers'];
const offlineResources = { databaseId: '00000000-0000-4000-8000-000000000001',
  previewDatabaseId: '00000000-0000-4000-8000-000000000002', bucketName: STAGING.bucketName };
const checks = {
  api: ['test:api', 'test:openapi', 'type-check'], admin: ['test:admin', 'type-check'],
  marketing: ['test:marketing', 'type-check'], containers: ['test:containers', 'check:containers'],
  previews: ['test:api', 'type-check'], site: ['docs:check', 'test', 'build:site:staging'],
  builder: ['test', 'build:builder:staging'], raindrop: ['build:staging', 'check:routes'],
};
const builds = { site: 'build:site:staging', builder: 'build:builder:staging', raindrop: 'build:staging' };
const execute = (command, args, options) => execFileSync(command, args, { stdio: 'inherit', ...options });
const capture = (run, command, args, options) => String(run(command, args,
  { ...options, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();
const versionId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export function validateStagingOperation(operation, target, env, sourceSha) {
  assert.ok(['check', 'check-backend', 'deploy', 'bootstrap', 'bootstrap-backend', 'migrate-api', 'migrate-previews'].includes(operation), 'Unknown staging operation.');
  assert.ok(stagingTargets.includes(target) || target === 'all' && operation !== 'deploy', 'Select one staging deploy target.');
  if (!['check', 'deploy'].includes(operation)) assert.equal(target, 'all', 'Backend checks, bootstrap, and migration operations use target all.');
  if (operation === 'check' || operation === 'check-backend') return;
  if (operation === 'bootstrap-backend') {
    assert.ok(/^[a-f0-9]{40}$/.test(sourceSha ?? ''), 'Identify a full source commit SHA for local staging bootstrap.');
    assert.ok(typeof env.CLOUDFLARE_API_TOKEN === 'string' && env.CLOUDFLARE_API_TOKEN.trim(), 'Configure a staging Cloudflare token.');
    assert.equal(env.CLOUDFLARE_ACCOUNT_ID, STAGING.accountId, 'Set the explicit staging Cloudflare account.');
    assert.ok(!env.CF_ACCOUNT_ID || env.CF_ACCOUNT_ID === STAGING.accountId, 'Staging account mismatch.');
    return;
  }
  assert.equal(env.GITHUB_ACTIONS, 'true', 'Publish staging through its GitHub workflow.');
  assert.equal(env.GITHUB_REPOSITORY, 'mainbrella/backend', 'Staging releases belong to backend repository.');
  assert.equal(env.GITHUB_WORKFLOW_REF, 'mainbrella/backend/.github/workflows/staging.yml@refs/heads/main', 'Use the main-owned staging workflow.');
  assert.equal(env.STAGING_DEPLOYS_ENABLED, 'true', 'Enable staging separately from production.');
  assert.ok(/^[a-f0-9]{40}$/.test(sourceSha ?? '') && sourceSha === env.RELEASE_SHA, 'Staging checkout differs from its selected source SHA.');
  assert.ok(typeof env.CLOUDFLARE_API_TOKEN === 'string' && env.CLOUDFLARE_API_TOKEN.trim(), 'Configure a staging Cloudflare token.');
  assert.ok(!env.CLOUDFLARE_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID === STAGING.accountId, 'Staging account mismatch.');
}

export function stagingSecrets(raw) {
  if (!raw) return {};
  let secrets;
  try { secrets = JSON.parse(raw); } catch { throw new Error('STAGING_SECRETS_JSON must be a JSON object.'); }
  assert.ok(secrets && typeof secrets === 'object' && !Array.isArray(secrets), 'STAGING_SECRETS_JSON must be a JSON object.');
  const allowed = new Set(['MONITORING_SECRET', 'IMAGE_BUILD_SECRET', 'STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PREPAID_PRICE_ID']);
  for (const [name, value] of Object.entries(secrets)) {
    assert.ok(allowed.has(name) && typeof value === 'string' && value.length > 0, 'Only explicitly supported STAGING_SECRETS_JSON keys may be installed.');
    if (name === 'STRIPE_SECRET_KEY') assert.ok(/^(?:sk|rk)_test_/.test(value), 'Staging accepts Stripe test keys only.');
    if (name === 'STRIPE_PUBLISHABLE_KEY') assert.ok(value.startsWith('pk_test_'), 'Staging accepts Stripe test publishable keys only.');
    if (name === 'STRIPE_PREPAID_PRICE_ID') assert.ok(/^price_[A-Za-z0-9_]+$/.test(value), 'Staging prepaid pricing needs a Stripe price ID.');
    if (name === 'MONITORING_SECRET' || name === 'IMAGE_BUILD_SECRET') assert.ok(value.length >= 32, 'Staging operational secrets need at least 32 characters.');
  }
  if (secrets.STRIPE_PREPAID_PRICE_ID) assert.ok(secrets.STRIPE_SECRET_KEY, 'Staging prepaid pricing requires an explicit Stripe test key.');
  if (secrets.MONITORING_SECRET && secrets.IMAGE_BUILD_SECRET) assert.notEqual(secrets.MONITORING_SECRET, secrets.IMAGE_BUILD_SECRET, 'Operational secrets must be distinct.');
  return secrets;
}

export function stagingBootstrapConfig(api) {
  assert.equal(api.name, 'mainbrella-api-stg');
  assert.equal(api.account_id, STAGING.accountId);
  return { name: api.name, account_id: api.account_id, main: 'worker/staging-bootstrap.ts',
    compatibility_date: api.compatibility_date, compatibility_flags: api.compatibility_flags,
    workers_dev: false, preview_urls: false, vars: { DEPLOYMENT_ENVIRONMENT: 'staging' },
    durable_objects: { bindings: api.durable_objects.bindings.filter(binding => !binding.script_name) },
    exports: api.exports };
}

// Published, immutable catalog bytes are shared read-only. This path never calls
// a production API, image manifest endpoint, image deployment lease, or builder.
export function publishedStagingImages({ directory = root, run = execute } = {}) {
  const options = { cwd: join(directory, '.') };
  const release = JSON.parse(capture(run, 'gh', ['api', 'repos/mainbrella/backend/releases/tags/terminal-image'], options));
  const readAsset = name => {
    const asset = release.assets?.find(item => item.name === name);
    assert.ok(Number.isSafeInteger(asset?.id), `Missing published ${name}; publish the maintained images separately.`);
    return JSON.parse(capture(run, 'gh', ['api', `repos/mainbrella/backend/releases/assets/${asset.id}`, '-H', 'Accept: application/octet-stream'], options));
  };
  const hash = createHash('sha256').update(readFileSync(join(directory, 'containers/Dockerfile'))).digest('hex');
  const terminal = validateImage(readAsset('terminal-image.json'), STAGING.accountId, hash);
  const images = validateCatalogImages(readAsset('catalog-images.json'), STAGING.accountId, join(directory, '.'));
  assert.equal(images.terminal?.image, terminal, 'Published terminal and catalog images differ.');
  return images;
}

export async function stagingOperation(operation, { target = 'all', directory = root, env = process.env,
  run = execute, request = fetch, provision = provisionStaging, preflight = preflightStaging,
  images = publishedStagingImages, log = console.log } = {}) {
  const sourceSha = capture(run, 'git', ['rev-parse', 'HEAD'], { cwd: directory });
  validateStagingOperation(operation, target, env, sourceSha);
  const secrets = operation === 'check' || operation === 'check-backend' ? {} : stagingSecrets(env.STAGING_SECRETS_JSON);
  const selected = operation.startsWith('migrate-') ? ['api'] : operation === 'check-backend' || operation === 'bootstrap-backend' ? stagingBackendTargets
    : operation === 'bootstrap' || target === 'all' ? stagingTargets : [target];
  const configurationTargets = [...new Set([...stagingTargets.filter(name => targetFor(name).directory === '.'), ...selected])];
  const tool = name => {
    const require = createRequire(join(directory, targetFor(name).directory, 'package.json'));
    return join(dirname(require.resolve('wrangler/package.json')), 'bin/wrangler.js');
  };
  if (operation === 'bootstrap-backend') {
    assert.equal(capture(run, 'git', ['status', '--porcelain'], { cwd: directory }), '', 'Commit all local changes before staging bootstrap.');
    const origin = capture(run, 'git', ['remote', 'get-url', 'origin'], { cwd: directory });
    assert.match(origin, /^(?:git@github\.com:|https:\/\/github\.com\/)mainbrella\/backend(?:\.git)?$/, 'Bootstrap only from the canonical backend repository origin.');
    const identity = JSON.parse(capture(run, process.execPath, [tool('api'), 'whoami', '--json'],
      { cwd: join(directory, '.'), env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    assert.ok(identity.loggedIn === true && Array.isArray(identity.accounts)
      && identity.accounts.some(account => account.id === STAGING.accountId),
    'Local Wrangler credentials must access the staging Cloudflare account.');
  }
  const nonce = randomUUID();
  const paths = {};
  const configurations = {};
  const output = join(directory, 'artifacts/staging', `${operation}-${nonce}`);
  mkdirSync(output, { recursive: true });
  const receipt = join(output, 'wrangler.jsonl');
  const publicationPlans = [];
  const sources = {};
  for (const relative of new Set(configurationTargets.map(name => targetFor(name).directory))) {
    const cwd = join(directory, relative);
    const sha = capture(run, 'git', ['rev-parse', 'HEAD'], { cwd });
    assert.match(sha, /^[a-f0-9]{40}$/, 'Identify each staging source checkout.');
    const dirty = Boolean(capture(run, 'git', ['status', '--porcelain'], { cwd }));
    if (!['check', 'check-backend'].includes(operation)) assert.ok(!dirty, 'Commit each repository before staging publication.');
    sources[relative] = { sourceSha: sha, dirty };
  }
  const evidence = { sourceSha, sources, environment: 'staging', operation, target, status: 'running', publications: [] };
  const record = () => writeFileSync(join(output, 'release.json'), JSON.stringify(evidence, null, 2) + '\n');
  const stageEnv = { ...env, VITE_API_URL: STAGING.apiOrigin, VITE_GA_MEASUREMENT_ID: '',
    VITE_GOOGLE_CLIENT_ID: env.STAGING_GOOGLE_CLIENT_ID || '' };
  const cwd = name => join(directory, targetFor(name).directory);
  const wrangler = (name, args, options = {}) => {
    assertStagingConfig(name, JSON.parse(readFileSync(paths[name], 'utf8')), configOptions(evidence.resources));
    return run(process.execPath, [tool(name), ...args, '--config', paths[name]], { cwd: cwd(name), env: stageEnv, ...options });
  };
  const wranglerJSON = (name, args) => JSON.parse(String(wrangler(name, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })));
  const configOptions = resources => ({ resources, directory, ...(env.STAGING_GOOGLE_CLIENT_ID ? { googleClientId: env.STAGING_GOOGLE_CLIENT_ID } : {}) });
  function render(resources) {
    for (const name of configurationTargets) {
      configurations[name] = stagingConfig(name, configOptions(resources));
      assertStagingConfig(name, configurations[name], configOptions(resources));
      paths[name] = join(cwd(name), `.wrangler-local-staging-${nonce}-${name}.jsonc`);
      writeFileSync(paths[name], JSON.stringify(configurations[name], null, 2));
    }
    stageEnv.VITE_GOOGLE_CLIENT_ID = configurations.api.vars.GOOGLE_CLIENT_ID;
  }
  function validatedHash(directories, configuration) {
    // Include the exact sanitized deployment config alongside the output bytes.
    return createHash('sha256').update(artifactHash(directories)).update('\0')
      .update(JSON.stringify(configuration)).digest('hex');
  }
  function bundle(name) {
    const config = structuredClone(configurations[name]);
    if (name === 'containers') delete config.containers;
    const path = join(cwd(name), `.wrangler-local-staging-${nonce}-bundle.jsonc`);
    const outdir = join('.wrangler', 'staging', name);
    try {
      writeFileSync(path, JSON.stringify(config));
      rmSync(join(cwd(name), outdir), { recursive: true, force: true });
      run(process.execPath, [tool(name), 'deploy', '--dry-run', '--config', path, '--outdir', outdir, '--metafile'], { cwd: cwd(name), env: stageEnv });
      if (['api', 'admin', 'marketing'].includes(name)) {
        checkWorkerBoundary(name, JSON.parse(readFileSync(join(cwd(name), outdir, 'bundle-meta.json'), 'utf8')));
      }
      return validatedHash([join(cwd(name), outdir),
        ...(targetFor(name).assets ? [join(cwd(name), targetFor(name).assets)] : [])], configurations[name]);
    } finally { rmSync(path, { force: true }); }
  }
  const hashes = {};
  function validateAndBuild(names) {
    const ran = new Set();
    for (const name of names) {
      for (const script of checks[name]) {
        const workspace = targetFor(name).directory;
        if (ran.has(`${workspace}:${script}`)) continue;
        run('npm', ['run', script], { cwd: cwd(name), env: stageEnv });
        ran.add(`${workspace}:${script}`);
      }
      hashes[name] = bundle(name);
    }
  }
  function readReceipts() {
    try {
      evidence.publications = readFileSync(receipt, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
        .filter(entry => entry.type === 'deploy' && entry.version_id).map((entry, index) => {
          assert.ok(versionId.test(entry.version_id) && Object.values(configurations).some(config => config.name === entry.worker_name), 'Unexpected staging publication receipt.');
          const name = stagingTargets.find(name => configurations[name]?.name === entry.worker_name);
          assert.equal(publicationPlans[index]?.target, name, 'Staging publication order differs from the requested operation.');
          return { worker: entry.worker_name, workerVersion: entry.version_id, target: name,
            validatedArtifactSha256: publicationPlans[index].hash, kind: publicationPlans[index].kind,
            deployedAt: entry.timestamp ?? null };
        });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  async function publish(name) {
    await preflight(name, { configurations, resources: evidence.resources, env: stageEnv, run: wranglerJSON, request, directory });
    const before = evidence.publications.length;
    const plan = { target: name, hash: null, kind: 'application' };
    publicationPlans.push(plan);
    const values = name === 'api' ? secrets : name === 'admin' && secrets.STRIPE_SECRET_KEY ? { STRIPE_SECRET_KEY: secrets.STRIPE_SECRET_KEY } : {};
    const secretPath = join(cwd(name), '.wrangler', `staging-secrets-${nonce}.json`);
    try {
      const outdir = join('.wrangler', 'staging', name);
      rmSync(join(cwd(name), outdir), { recursive: true, force: true });
      const args = ['deploy', '--outdir', outdir];
      if (Object.keys(values).length) {
        mkdirSync(dirname(secretPath), { recursive: true });
        writeFileSync(secretPath, JSON.stringify(values), { mode: 0o600, flag: 'wx' });
        args.push('--secrets-file', secretPath);
      }
      // Install test-only secrets in the same version as the code; secret bulk
      // would create an additional version outside this publication receipt.
      wrangler(name, args, { env: { ...stageEnv, WRANGLER_OUTPUT_FILE_PATH: receipt } });
      plan.hash = validatedHash([join(cwd(name), outdir),
        ...(targetFor(name).assets ? [join(cwd(name), targetFor(name).assets)] : [])], configurations[name]);
    } finally { rmSync(secretPath, { force: true }); }
    readReceipts();
    assert.equal(evidence.publications.length, before + 1, 'Each staging publisher must report exactly one version.');
    assert.equal(evidence.publications.at(-1).worker, configurations[name].name, 'Staging publisher reported the wrong worker.');
    record();
  }
  async function existingApi() {
    let response, body;
    try {
      response = await request(`https://api.cloudflare.com/client/v4/accounts/${STAGING.accountId}/workers/scripts/mainbrella-api-stg/deployments`, {
        method: 'GET', headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` }, redirect: 'error', signal: AbortSignal.timeout(20_000),
      });
      if (response.status === 404) return false;
      body = await response.json();
    } catch { throw new Error('Cannot inspect the existing staging API before bootstrap.'); }
    assert.ok(response.ok && body.success === true && body.result?.deployments?.length, 'Cannot qualify the existing staging API; inspect it before bootstrap.');
    return true;
  }
  record();
  try {
    render(offlineResources);
    if (operation === 'check' || operation === 'check-backend') {
      validateAndBuild(selected);
      evidence.status = 'success';
      evidence.validatedArtifacts = hashes;
      return evidence;
    }
    evidence.resources = await provision({ env: stageEnv, request, create: operation === 'bootstrap' || operation === 'bootstrap-backend' });
    render(evidence.resources);
    if (operation === 'migrate-api' || operation === 'migrate-previews' || operation === 'bootstrap' || operation === 'bootstrap-backend') {
      const databases = operation === 'bootstrap' || operation === 'bootstrap-backend' ? ['DB', 'PREVIEW_ROUTES'] : [operation === 'migrate-api' ? 'DB' : 'PREVIEW_ROUTES'];
      for (const database of databases) wrangler('api', ['d1', 'migrations', 'apply', database, '--remote']);
      evidence.migrations = databases;
      if (operation !== 'bootstrap' && operation !== 'bootstrap-backend') { evidence.status = 'success'; return evidence; }
    }
    for (const name of selected) {
      if (builds[name]) run('npm', ['run', builds[name]], { cwd: cwd(name), env: stageEnv });
    }
    if (selected.includes('containers')) {
      configurations.containers.containers[0].images = images({ directory, run });
      assertStagingConfig('containers', configurations.containers, configOptions(evidence.resources));
      writeFileSync(paths.containers, JSON.stringify(configurations.containers, null, 2));
      evidence.imageDigests = configurations.containers.containers[0].images;
    }
    if (operation === 'bootstrap' || operation === 'bootstrap-backend') {
      if (!await existingApi()) {
        const bootstrapPath = join(cwd('api'), `.wrangler-local-staging-${nonce}-bootstrap.jsonc`);
        try {
          writeFileSync(bootstrapPath, JSON.stringify(stagingBootstrapConfig(configurations.api)));
          const bootstrapBundle = join('.wrangler', 'staging', 'bootstrap-api');
          rmSync(join(cwd('api'), bootstrapBundle), { recursive: true, force: true });
          const plan = { target: 'api', hash: null, kind: 'bootstrap-declarations' };
          publicationPlans.push(plan);
          run(process.execPath, [tool('api'), 'deploy', '--config', bootstrapPath, '--outdir', bootstrapBundle], { cwd: cwd('api'), env: { ...stageEnv, WRANGLER_OUTPUT_FILE_PATH: receipt } });
          plan.hash = validatedHash([join(cwd('api'), bootstrapBundle)], stagingBootstrapConfig(configurations.api));
          readReceipts();
          assert.equal(evidence.publications.length, 1, 'The staging namespace bootstrap must report exactly one version.');
          record();
        } finally { rmSync(bootstrapPath, { force: true }); }
      }
      await publish('admin');
      await publish('marketing');
      await publish('containers');
      await publish('api');
      if (operation === 'bootstrap') {
        await publish('previews');
        for (const name of ['site', 'builder', 'raindrop']) await publish(name);
      }
    } else {
      // The selected worker already exists on ordinary releases; initial install
      // is the explicit bootstrap operation above.
      await publish(target);
    }
    evidence.status = 'success';
    return evidence;
  } catch (error) {
    evidence.status = 'failed';
    evidence.failure = error.status ? 'Staging command failed; inspect command output and recorded worker versions.' : error.message;
    throw error;
  } finally {
    for (const path of Object.values(paths)) rmSync(path, { force: true });
    try { readReceipts(); } catch { evidence.receiptError = 'Publication output could not be fully decoded; inspect wrangler.jsonl before retrying.'; }
    evidence.finishedAt = new Date().toISOString();
    record();
    log(`Staging ${operation}: ${evidence.status}. Evidence: ${join(output, 'release.json')}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  stagingOperation(process.argv[2], { target: process.argv[3] ?? 'all' }).catch(error => {
    console.error(error.status ? 'Staging command failed. Inspect the release evidence before retrying.' : error.message);
    process.exitCode = 1;
  });
}

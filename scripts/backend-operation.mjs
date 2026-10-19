import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { artifactHash } from './release.mjs';
import { targetFor } from './staging-targets.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sequences = {
  release: ['containers', 'previews', 'admin', 'marketing', 'api'],
  'bootstrap-activity': ['containers', 'admin', 'marketing', 'api', 'containers', 'previews'],
};
const scripts = {
  release: 'deploy:all',
  'bootstrap-activity': 'deploy:bootstrap-activity',
  'migrate-api': 'db:migrate:remote',
  'migrate-previews': 'db:migrate:previews:remote',
};
const execute = (command, args, options) => execFileSync(command, args, { stdio: 'inherit', ...options });
const capture = (run, command, args, options) => String(run(command, args,
  { ...options, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();

export function validateOperation(operation, env, sourceSha) {
  if (!Object.hasOwn(scripts, operation)) throw new Error('Choose release, bootstrap-activity, migrate-api, or migrate-previews.');
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== 'mainbrella/backend'
    || env.GITHUB_WORKFLOW_REF !== 'mainbrella/backend/.github/workflows/backend-operations.yml@refs/heads/main') {
    throw new Error('Backend operations must run through the protected backend repository backend workflow.');
  }
  if (!/^[a-f0-9]{40}$/.test(env.RELEASE_SHA ?? '') || sourceSha !== env.RELEASE_SHA) {
    throw new Error('Backend operation checkout differs from the selected source SHA.');
  }
}

export function parseWranglerDeploys(content) {
  const records = [];
  const errors = [];
  for (const line of content.split('\n').filter(Boolean)) {
    let entry;
    try { entry = JSON.parse(line); } catch { errors.push('Wrangler deployment output contains invalid JSON.'); continue; }
    if (entry.type !== 'deploy' || entry.version_id == null) continue;
    if (entry.version !== 1 || typeof entry.worker_name !== 'string'
      || !/^[a-f0-9-]{36}$/.test(entry.version_id)) {
      errors.push('Wrangler deployment output has an invalid worker or version.');
      continue;
    }
    records.push({ worker: entry.worker_name, workerVersion: entry.version_id,
      deployedAt: entry.timestamp ?? null });
  }
  return { records, errors };
}

export function backendOperation(operation, { directory = root, env = process.env, run = execute,
  record = writeFileSync, now = () => new Date().toISOString(), log = console.log } = {}) {
  const sourceSha = capture(run, 'git', ['rev-parse', 'HEAD'], { cwd: directory });
  validateOperation(operation, env, sourceSha);
  const output = join(directory, 'artifacts/releases');
  mkdirSync(output, { recursive: true });
  const evidencePath = join(output, `backend-${operation}-${sourceSha}.json`);
  const wranglerPath = join(output, `wrangler-${operation}-${randomUUID()}.jsonl`);
  const targets = sequences[operation] ?? [];
  const evidence = { operation, sourceSha, environment: 'production', startedAt: now(),
    status: 'running', publications: [] };
  record(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
  let failure;
  try {
    if (!targets.length) {
      const migrationDir = operation === 'migrate-api' ? 'migrations' : 'preview-migrations';
      evidence.migrationSourceSha256 = artifactHash([join(directory, '.', migrationDir)]);
    }
    run('npm', ['run', scripts[operation]], {
      cwd: join(directory, '.'),
      env: { ...env, WRANGLER_OUTPUT_FILE_PATH: wranglerPath },
    });
    evidence.status = 'success';
  } catch (error) {
    failure = error;
    evidence.status = 'failed';
    evidence.failure = error.status ? 'Selected backend operation command failed.' : error.message;
  } finally {
    try {
      const raw = existsSync(wranglerPath) ? readFileSync(wranglerPath, 'utf8') : '';
      const { records: deployed, errors } = parseWranglerDeploys(raw);
      evidence.publications = deployed.map((entry, index) => {
        const target = targets[index];
        const matched = target && entry.worker === targetFor(target).worker;
        return { ...entry, target: matched ? target : null, sourceSha };
      });
      if (errors.length) throw new Error(errors.join(' '));
      if (evidence.publications.some(entry => !entry.target)) {
        throw new Error('Unexpected Worker publication; inspect the raw Wrangler output.');
      }
      if (!failure && targets.length && deployed.length !== targets.length) {
        throw new Error(`Expected ${targets.length} Worker publications; recorded ${deployed.length}.`);
      }
      if (!failure && !targets.length && deployed.length) {
        throw new Error('Migration operation unexpectedly published a Worker.');
      }
    } catch (error) {
      failure ??= error;
      evidence.status = 'failed';
      evidence.evidenceError = error.message;
    }
    if (failure && targets.length && evidence.publications.length < targets.length) {
      evidence.remainingPublicationsUnconfirmed = true;
    }
    evidence.finishedAt = now();
    record(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
  }
  if (failure) throw failure;
  log(JSON.stringify(evidence));
  return evidence;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Use backend-operation.mjs <operation>.');
    backendOperation(process.argv[2]);
  } catch (error) {
    console.error(error.status ? 'Backend operation failed. Inspect release evidence and deployed Worker versions before retrying.' : error.message);
    process.exitCode = 1;
  }
}

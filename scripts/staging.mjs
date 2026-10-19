import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { STAGING } from './staging-config.mjs';
import { provisionStaging } from './staging-resources.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const TARGETS = new Set(['api', 'admin', 'marketing', 'containers', 'previews', 'site', 'builder', 'raindrop']);
const OPERATIONS = new Set(['bootstrap', 'migrate-api', 'migrate-previews']);
const execute = (command, args, options) => execFileSync(command, args, { stdio: 'inherit', ...options });
const capture = (run, command, args, options) => String(run(command, args, {
  ...options, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
})).trim();

function usage() {
  return 'Usage: node scripts/staging.mjs plan | check [target] | provision [--apply] | deploy <target> | bootstrap | migrate-api | migrate-previews';
}

export function parseArguments(args) {
  const [command, ...rest] = args;
  if (command === 'plan' && rest.length === 0) return { command };
  if (command === 'check' && rest.length <= 1 && (rest.length === 0 || rest[0] === 'all' || TARGETS.has(rest[0]))) {
    return { command, target: rest[0] ?? 'all' };
  }
  if (command === 'provision' && (rest.length === 0 || (rest.length === 1 && rest[0] === '--apply'))) {
    return { command, apply: rest[0] === '--apply' };
  }
  if (command === 'deploy' && rest.length === 1 && TARGETS.has(rest[0])) return { command, target: rest[0] };
  if (OPERATIONS.has(command) && rest.length === 0) return { command, target: 'all' };
  throw new Error(usage());
}

export function stagingPlan() {
  return {
    hosts: {
      web: STAGING.webOrigin,
      api: STAGING.apiOrigin,
      admin: STAGING.adminOrigin,
    },
    resources: {
      database: STAGING.databaseName,
      previewDatabase: STAGING.previewDatabaseName,
      bucket: STAGING.bucketName,
    },
  };
}

function dispatchOperation(operation, target, { run = execute, directory = root, log = console.log } = {}) {
  const options = { cwd: directory };
  if (capture(run, 'git', ['status', '--porcelain'], options)) {
    throw new Error('Commit the intended staging source before dispatching it.');
  }
  const sha = capture(run, 'git', ['rev-parse', 'HEAD'], options);
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Cannot identify the selected source commit.');
  const branch = capture(run, 'git', ['branch', '--show-current'], options);
  if (!branch) throw new Error('Select a named branch before dispatching staging work.');
  run('git', ['check-ref-format', '--branch', branch], options);
  const remote = capture(run, 'git', ['remote', 'get-url', 'origin'], options);
  if (!/^(?:git@github\.com:|https:\/\/github\.com\/)mainbrella\/backend(?:\.git)?$/.test(remote)) {
    throw new Error('Origin must be mainbrella/backend.');
  }
  run('git', ['fetch', '--no-tags', 'origin', branch], options);
  run('git', ['merge-base', '--is-ancestor', sha, 'FETCH_HEAD'], options);
  run('gh', ['workflow', 'run', 'staging.yml', '--repo', 'mainbrella/backend', '--ref', 'main',
    '-f', `operation=${operation}`, '-f', `target=${target}`, '-f', `source_sha=${sha}`, '-f', `source_branch=${branch}`], options);
  log(`Requested staging ${operation}${operation === 'deploy' ? ` for ${target}` : ''} at ${sha}. Follow the staging run in mainbrella/backend Actions.`);
}

export async function runStaging(args, options = {}) {
  const parsed = parseArguments(args);
  const { run = execute, directory = root, env = process.env, request = fetch, log = console.log,
    operation, provision = provisionStaging } = options;
  if (parsed.command === 'plan') {
    log(JSON.stringify(stagingPlan(), null, 2));
    return;
  }
  if (parsed.command === 'check') {
    const stagingOperation = operation ?? (await import('./staging-release.mjs')).stagingOperation;
    const result = await stagingOperation('check', { target: parsed.target, directory, env, run, request });
    if (result !== undefined) log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
    return result;
  }
  if (parsed.command === 'provision') {
    if (!parsed.apply) {
      log(JSON.stringify({ ...stagingPlan(), action: 'plan only', apply: 'node scripts/staging.mjs provision --apply' }, null, 2));
      return;
    }
    const resources = await provision({ env, request, create: true });
    log(JSON.stringify({ resources }, null, 2));
    return resources;
  }
  if (parsed.command === 'deploy' || OPERATIONS.has(parsed.command)) {
    dispatchOperation(parsed.command, parsed.target, { run, directory, log });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runStaging(process.argv.slice(2)).catch(error => {
    console.error(error.status ? 'Staging command failed. Review the preceding command output before retrying.' : error.message);
    process.exitCode = 1;
  });
}

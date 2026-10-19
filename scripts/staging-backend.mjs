import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { STAGING } from './staging-config.mjs';
import { stagingOperation } from './staging-release.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const execute = (command, args, options) => execFileSync(command, args, { stdio: 'inherit', ...options });

export function parseArguments(args) {
  if (args.length === 1 && args[0] === '--check') return { publish: false };
  if (args.length === 1 && args[0] === '--publish') return { publish: true };
  throw new Error('Usage: node scripts/staging-backend.mjs --check | --publish');
}

export async function deployStagingBackend({ publish = false, directory = root, env = process.env,
  run = execute, operation = stagingOperation, log = console.log } = {}) {
  for (const name of ['CLOUDFLARE_ACCOUNT_ID', 'CF_ACCOUNT_ID']) {
    assert.ok(!env[name] || env[name] === STAGING.accountId, `${name} must match the staging Cloudflare account.`);
  }
  const deploymentEnv = { ...env, CLOUDFLARE_ACCOUNT_ID: STAGING.accountId };
  if (publish && !deploymentEnv.CLOUDFLARE_API_TOKEN?.trim()) {
    const require = createRequire(join(directory, 'package.json'));
    const wrangler = join(dirname(require.resolve('wrangler/package.json')), 'bin/wrangler.js');
    try {
      // Capture credentials only in memory. Never forward auth-token output to
      // the terminal, release evidence, GitHub secrets, or a file.
      const output = run(process.execPath, [wrangler, 'auth', 'token', '--json'], {
        cwd: join(directory, '.'), env: { ...env, WRANGLER_WRITE_LOGS: 'false' },
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
      const credential = JSON.parse(String(output));
      assert.ok(['oauth', 'api_token'].includes(credential.type)
        && typeof credential.token === 'string' && credential.token.trim());
      deploymentEnv.CLOUDFLARE_API_TOKEN = credential.token;
    } catch {
      throw new Error('Cloudflare credentials are unavailable. Run wrangler login or set CLOUDFLARE_API_TOKEN, then retry.');
    }
  }
  return operation(publish ? 'bootstrap-backend' : 'check-backend', {
    target: 'all', directory, env: deploymentEnv, run, log,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  Promise.resolve().then(() => deployStagingBackend(parseArguments(process.argv.slice(2)))).catch(error => {
    console.error(error.status ? 'Staging backend command failed. Inspect its output and release evidence before retrying.' : error.message);
    process.exitCode = 1;
  });
}

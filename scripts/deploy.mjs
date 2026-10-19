import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { release } from './release.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const execute = (command, args, options) => execFileSync(command, args, { stdio: 'inherit', ...options });

export function parseArguments(args) {
  if (!args.length) return { mode: 'publish' };
  if (args.length === 1 && args[0] === '--check') return { mode: 'check' };
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { mode: 'help' };
  throw new Error('Usage: npm run deploy [-- --check]. Publishes the API directly from this machine after applying its D1 migrations.');
}

export function deployBackend({ publish = true, directory = root, env = process.env, run = execute } = {}) {
  return release('api', { publish, local: publish, directory, env, run });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { mode } = parseArguments(process.argv.slice(2));
    if (mode === 'help') {
      console.log('npm run deploy                 Apply D1 migrations and deploy the API from this machine.');
      console.log('npm run deploy -- --check      Run API checks and bundle without publishing.');
      console.log('npm run deploy:all             Run the full backend rollout, including containers and private services.');
    } else deployBackend({ publish: mode === 'publish' });
  } catch (error) {
    console.error(error.status ? 'Backend deployment failed. Review the preceding output before retrying.' : error.message);
    process.exitCode = 1;
  }
}

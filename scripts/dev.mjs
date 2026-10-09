import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { LocalProxyCleanup } from './local-proxy-cleanup.mjs';
import { IMAGE_CATALOG } from '../containers/image-catalog.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const allImages = process.argv.slice(2).includes('--all-images');
const args = process.argv.slice(2).filter(arg => arg !== '--all-images');
const persistIndex = args.indexOf('--persist-to');
const persistPath = args.find(arg => arg.startsWith('--persist-to='))?.slice('--persist-to='.length)
  ?? (persistIndex >= 0 ? args[persistIndex + 1] : undefined);
const containers = JSON.parse(readFileSync(`${root}wrangler.containers.jsonc`, 'utf8'));
const cleanup = new LocalProxyCleanup({ statePath: resolve(root, persistPath ?? '.wrangler/state'),
  workerName: containers.name, className: 'UserContainer' });
let sweeping = null;
let warned = false;
function sweep(shutdown = false) {
  if (sweeping) return sweeping.then(() => shutdown ? sweep(true) : undefined);
  sweeping = cleanup.sweep({ shutdown }).then(removed => {
    if (removed) console.log(`Cleaned up ${removed} local container ${removed === 1 ? 'proxy' : 'proxies'}.`);
    warned = false;
  }).catch(() => {
    if (!warned) console.warn('Local proxy cleanup could not inspect Docker; leaving containers unchanged.');
    warned = true;
  }).finally(() => { sweeping = null; });
  return sweeping;
}
await sweep();
// Keep bindings and variables in sync with the deployment configuration, while
// preventing Wrangler from rewriting local preview hosts to the deployed route.
const configPaths = ['api', 'containers'].map(name => {
  const source = name === 'api' ? 'wrangler.jsonc' : 'wrangler.containers.jsonc';
  const config = JSON.parse(readFileSync(`${root}${source}`, 'utf8'));
  if (name === 'containers' && allImages) {
    for (const container of config.containers ?? []) {
      if (container.class_name === 'UserContainer') {
        container.images = {
          ...container.images,
          ...Object.fromEntries(IMAGE_CATALOG.map(image => [image.key, { dockerfile: `./${image.dockerfile}` }])),
        };
      }
    }
  }
  delete config.routes;
  delete config.route;
  config.vars = { ...config.vars, LOCAL_DEV: 'true' };
  if (name === 'api') {
    const portIndex = args.indexOf('--port');
    const port = args.find(arg => arg.startsWith('--port='))?.slice('--port='.length)
      ?? (portIndex >= 0 ? args[portIndex + 1] : undefined) ?? config.dev?.port ?? '8787';
    config.vars = { ...config.vars, PROJECT_HOSTING_ENABLED: 'true', PROJECT_DOMAIN_PROVIDER: 'local', LOCAL_PREVIEW_PORT: String(port) };
  }
  const path = `${root}.wrangler-local-${name}-${process.pid}.jsonc`;
  writeFileSync(path, JSON.stringify(config, null, 2));
  return path;
});
const child = spawn(`${root}node_modules/.bin/wrangler`, [
  'dev', '--local', ...configPaths.flatMap(path => ['--config', path]), ...args,
], { cwd: root, stdio: 'inherit' });
process.on('exit', () => { for (const path of configPaths) { try { unlinkSync(path); } catch {} } });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { child.kill(signal); });
const timer = setInterval(() => { void sweep(); }, 15_000);
async function finish(code) {
  clearInterval(timer);
  await sweep(true);
  process.exitCode = code;
}
child.on('error', error => { console.error(error.message); void finish(1); });
child.on('exit', (code, signal) => { void finish(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1)); });

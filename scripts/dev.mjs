import { readFileSync, writeFileSync, unlinkSync, existsSync, chmodSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { LocalProxyCleanup } from './local-proxy-cleanup.mjs';
import { IMAGE_CATALOG } from '../containers/image-catalog.js';
import { startCodexBridge } from './codex-bridge.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const allImages = process.argv.slice(2).includes('--all-images');
const args = process.argv.slice(2).filter(arg => arg !== '--all-images');
const aiIndex = args.findIndex(arg => arg === '--ai' || arg.startsWith('--ai='));
const aiMode = aiIndex < 0 ? 'workers' : args[aiIndex].includes('=') ? args[aiIndex].slice('--ai='.length) : args[aiIndex + 1];
if (!['workers', 'codex'].includes(aiMode)) {
  console.error('Use --ai=codex for local Codex inference, or --ai=workers for the default provider.');
  process.exit(1);
}
if (aiIndex >= 0) args.splice(aiIndex, args[aiIndex].includes('=') ? 1 : 2);
let child, bridge, shutdownSignal;
const startup = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  shutdownSignal = signal; startup.abort(); child?.kill(signal);
});
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
const configPaths = ['api', 'containers', 'admin', 'marketing'].map(name => {
  const source = name === 'api' ? 'wrangler.jsonc' : `wrangler.${name}.jsonc`;
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
    try {
      const saved = JSON.parse(readFileSync(`${root}.github-build-local-secrets.json`, 'utf8'));
      const keys = ['GITHUB_BUILD_CLIENT_ID', 'GITHUB_BUILD_CLIENT_SECRET', 'GITHUB_BUILD_APP_SLUG', 'GITHUB_BUILD_ENCRYPTION_KEY'];
      if (keys.some(key => typeof saved[key] !== 'string' || !saved[key]) || !/^[A-Za-z0-9-]+$/.test(saved.GITHUB_BUILD_APP_SLUG)
        || !/^[a-f0-9]{64}$/.test(saved.GITHUB_BUILD_ENCRYPTION_KEY)) throw new Error('Invalid local GitHub Build credentials.');
      // Wrangler treats .env/.dev.vars values as secrets and masks them in logs.
      // Preserve the user's other settings and honor .dev.vars precedence.
      const envFile = `${root}${existsSync(`${root}.dev.vars`) ? '.dev.vars' : '.env'}`;
      let contents = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
      for (const key of keys) {
        const line = `${key}=${JSON.stringify(saved[key])}`;
        const pattern = new RegExp(`^(?:export\\s+)?${key}\\s*=.*$`, 'gm');
        if (pattern.test(contents)) contents = contents.replace(pattern, () => line);
        else contents += `${contents && !contents.endsWith('\n') ? '\n' : ''}${line}\n`;
      }
      writeFileSync(envFile, contents, { mode: 0o600 });
      chmodSync(envFile, 0o600);
      console.log('GitHub Build: local app configuration loaded.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Could not load .github-build-local-secrets.json. Check the local GitHub app registration.');
    }
    const portIndex = args.indexOf('--port');
    const port = args.find(arg => arg.startsWith('--port='))?.slice('--port='.length)
      ?? (portIndex >= 0 ? args[portIndex + 1] : undefined) ?? config.dev?.port ?? '8787';
    config.vars = { ...config.vars, PROJECT_HOSTING_ENABLED: 'true', PROJECT_DOMAIN_PROVIDER: 'local', LOCAL_PREVIEW_PORT: String(port) };
  }
  const path = `${root}.wrangler-local-${name}-${process.pid}.jsonc`;
  writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 });
  return path;
});
const removeConfigs = () => { for (const path of configPaths) { try { unlinkSync(path); } catch {} } };
process.on('exit', removeConfigs);
const localStatePath = resolve(root, persistPath ?? '.wrangler/state');
const wrangler = `${root}node_modules/.bin/wrangler`;
for (const database of ['delta', 'mainbrella-preview-routes']) {
  const migration = spawnSync(wrangler, [
    'd1', 'migrations', 'apply', database, '--local', '--config', configPaths[0], '--persist-to', localStatePath,
  ], { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] });
  if (migration.error) console.error(`Could not apply local ${database} migrations: ${migration.error.message}`);
  if (migration.status !== 0) {
    process.exitCode = migration.status ?? 1;
    removeConfigs();
    process.exit();
  }
}
if (aiMode === 'codex') {
  try {
    bridge = await startCodexBridge({ signal: startup.signal });
    const config = JSON.parse(readFileSync(configPaths[0], 'utf8'));
    // Codex handles code; retain Workers AI for original image generation.
    // The bridge is a loopback HTTP service, reachable only during local dev.
    config.compatibility_flags = (config.compatibility_flags ?? []).filter(flag => flag !== 'global_fetch_strictly_public');
    config.vars = { ...config.vars, BUILD_CODEX_URL: bridge.url, BUILD_CODEX_TOKEN: bridge.token, BUILD_MODEL: bridge.model };
    writeFileSync(configPaths[0], JSON.stringify(config, null, 2));
    console.log(`Local Build inference: ${bridge.model} via codex app-server (remote inference).`);
  } catch (error) {
    if (!shutdownSignal) console.error(error.message);
    await bridge?.close();
    await sweep(true); removeConfigs();
    process.exit(shutdownSignal === 'SIGINT' ? 130 : shutdownSignal === 'SIGTERM' ? 143 : 1);
  }
}
if (shutdownSignal) {
  await bridge?.close(); await sweep(true); removeConfigs();
  process.exit(shutdownSignal === 'SIGINT' ? 130 : 143);
}
child = spawn(wrangler, [
  'dev', '--local', ...configPaths.flatMap(path => ['--config', path]), ...args,
], { cwd: root, stdio: 'inherit' });
const timer = setInterval(() => { void sweep(); }, 15_000);
let finishing;
async function finish(code) {
  return finishing ??= (async () => {
    clearInterval(timer);
    await bridge?.close();
    await sweep(true);
    removeConfigs();
    process.exitCode = code;
  })();
}
child.on('error', error => { console.error(error.message); void finish(1); });
child.on('exit', (code, signal) => { void finish(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1)); });

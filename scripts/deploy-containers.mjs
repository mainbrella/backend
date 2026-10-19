import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseEnv, promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { assembleImageMap, imageBuildApi } from './custom-images.mjs';
import { validateImage } from './terminal-image.mjs';
import { validateCatalogImages } from './catalog-images.mjs';
import { resolveTool } from './resolve-tool.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const repository = 'mainbrella/backend';
const config = JSON.parse(readFileSync(join(root, 'wrangler.containers.jsonc'), 'utf8'));
const dockerfileHash = createHash('sha256').update(readFileSync(join(root, './containers/Dockerfile'))).digest('hex');
const args = process.argv.slice(2);
const outdirArgs = args.filter(arg => arg.startsWith('--outdir='));
if (outdirArgs.length > 1 || outdirArgs.some(arg => !arg.slice('--outdir='.length).trim())) {
  throw new Error('Use one nonempty --outdir=<path> for deployment output.');
}
const securityArgs = args.filter(arg => arg.startsWith('--security-account='));
if (securityArgs.length > 1 || securityArgs.some(arg => !/^[A-Za-z0-9_-]{1,128}$/.test(arg.slice('--security-account='.length)))) {
  throw new Error('Use one exact authenticated account ID for the private security canary.');
}
if (securityArgs.length) config.vars = { ...config.vars, EGRESS_POLICIES_ENABLED: 'true', SECURITY_FEATURE_ACCOUNTS: securityArgs[0].slice('--security-account='.length) };
// Keep deployment arguments from replacing the generated config or account.
if (args.some(arg => !['--dry-run', '--without-activity'].includes(arg) && !securityArgs.includes(arg) && !outdirArgs.includes(arg))) {
  console.error('Only --dry-run, --without-activity, --outdir=<path> and --security-account=<ID> are supported. Use npm run deploy:containers.');
  process.exit(1);
}
// Bootstrap the runtime before the API exports AccountActivity. Activity delivery
// already tolerates a missing binding; the final deployment restores it.
if (args.includes('--without-activity')) {
  config.durable_objects.bindings = config.durable_objects.bindings.filter(binding => binding.name !== 'ACCOUNT_ACTIVITY');
  console.log('Activity delivery omitted for bootstrap. Finish with API, then normal container deployment.');
}
const wranglerArgs = args.filter(arg => arg !== '--without-activity' && !securityArgs.includes(arg));

const shutdown = new AbortController();
let shutdownSignal;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (shutdownSignal) return;
  shutdownSignal = signal;
  console.error(`${signal}: cancelling deployment and cleaning up its image lease...`);
  shutdown.abort();
});

const execFileAsync = promisify(execFile);
async function githubJson(path, label, asset = false) {
  shutdown.signal.throwIfAborted();
  console.log(`Fetching ${label} from GitHub (60s timeout)...`);
  const { stdout } = await execFileAsync('gh', ['api', path, ...(asset ? ['-H', 'Accept: application/octet-stream'] : [])],
    { encoding: 'utf8', cwd: root, timeout: 60_000, killSignal: 'SIGKILL', signal: shutdown.signal });
  return JSON.parse(stdout);
}

// Wrangler's bin entry point spawns another Node process. Stop the whole process
// group before releasing the lease, including when only this script gets SIGTERM.
async function deployWithWrangler() {
  shutdown.signal.throwIfAborted();
  const started = Date.now();
  const grouped = process.platform !== 'win32';
  const child = spawn(process.execPath, [resolveTool('wrangler', 'bin/wrangler.js'), 'deploy', '--config', temporaryConfig, ...wranglerArgs],
    { cwd: root, stdio: 'inherit', detached: grouped });
  const stop = signal => {
    if (!child.pid) return;
    try {
      if (grouped) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  let forcedStop;
  let timedOut = false;
  const cancel = () => {
    stop('SIGTERM');
    forcedStop = setTimeout(() => stop('SIGKILL'), 5_000);
  };
  shutdown.signal.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(() => { timedOut = true; stop('SIGKILL'); }, 10 * 60_000);
  const progress = setInterval(() => {
    console.log(`Container deployment still running (${Math.round((Date.now() - started) / 1000)}s elapsed; 10-minute timeout). See Wrangler's last stage above.`);
  }, 30_000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => resolve(code ?? 1));
    });
    shutdown.signal.throwIfAborted();
    if (timedOut) throw new Error('Container deployment timed out after 10 minutes. Check the deployed version and Cloudflare image preparation before retrying.');
    return code;
  } finally {
    clearTimeout(timeout);
    clearTimeout(forcedStop);
    clearInterval(progress);
    shutdown.signal.removeEventListener('abort', cancel);
    // Also stop a descendant left behind if the Wrangler launcher exits first.
    if (grouped) stop('SIGKILL');
  }
}

// Read the authoritative map under a deployment lease. Never silently deploy an
// empty or stale release snapshot when the API is unavailable.
const lease = randomUUID();
let releaseLease = false;
const temporaryConfig = join(root, `.wrangler-containers-${randomUUID()}.json`);
try {
  let image;
  let catalog;
  try {
    const release = await githubJson(`repos/${repository}/releases/tags/terminal-image`, 'published image release');
    const asset = release.assets.find(asset => asset.name === 'terminal-image.json');
    if (!asset) throw new Error('missing image manifest');
    const manifest = await githubJson(`repos/${repository}/releases/assets/${asset.id}`, 'terminal image manifest', true);
    image = validateImage(manifest, config.account_id, dockerfileHash);
    const catalogAsset = release.assets.find(asset => asset.name === 'catalog-images.json');
    if (!catalogAsset) throw new Error('Catalog images have not been published. Run the Build MainBrella images workflow first.');
    const catalogManifest = await githubJson(`repos/${repository}/releases/assets/${catalogAsset.id}`, 'catalog image manifest', true);
    catalog = validateCatalogImages(catalogManifest, config.account_id, root);
    if (catalog.terminal.image !== image) throw new Error('Catalog and terminal manifests differ. Run the Build MainBrella images workflow first.');
  } catch (error) {
    shutdown.signal.throwIfAborted();
    const reason = error.code === 'ENOENT' ? 'Install GitHub CLI (gh) and run gh auth login.' : error.killed ?
      'GitHub image manifest request timed out after 60 seconds.' :
      /^(Image |Catalog |Incomplete |Invalid )/.test(error.message) ? error.message : 'release unavailable; check gh auth status and the Build MainBrella images workflow.';
    throw new Error(`Cannot use the published images: ${reason}\nRun the Build MainBrella images workflow at https://github.com/${repository}/actions, then retry.`);
  }
  // Node does not load Wrangler's local .env automatically. Import only the
  // shared image secret, preserving any explicit shell/Actions value.
  if (process.env.IMAGE_BUILD_SECRET === undefined) {
    try {
      const local = parseEnv(readFileSync(join(root, '.env'), 'utf8'));
      if (local.IMAGE_BUILD_SECRET !== undefined) process.env.IMAGE_BUILD_SECRET = local.IMAGE_BUILD_SECRET;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!args.includes('--dry-run')) {
    console.log('Acquiring image deployment lease...');
    const started = Date.now();
    // An interrupted older deploy may leave its entire 12-minute lease behind.
    const deadline = started + 13 * 60_000;
    while (true) {
      shutdown.signal.throwIfAborted();
      // A failed request can still have acquired the lease on the server. DELETE
      // is token-scoped, so cleanup cannot release another deployment's lease.
      releaseLease = true;
      const result = await imageBuildApi('/deployment-lock', 'POST', { token: lease });
      if (result.ok) { console.log('Image deployment lease acquired.'); break; }
      releaseLease = false;
      if (result.status !== 409) throw new Error(`Image deployment lease unavailable (HTTP ${result.status}).`);
      if (Date.now() >= deadline) throw new Error('Image deployment is still busy after 13 minutes. Check other deployments or image builds before retrying.');
      console.log(`Image deployment lease is busy (${Math.round((Date.now() - started) / 1000)}s elapsed). Retrying in 10s; an interrupted deployment's lease expires within 12 minutes.`);
      await sleep(10_000, undefined, { signal: shutdown.signal });
    }
  }
  shutdown.signal.throwIfAborted();
  console.log('Fetching live custom image manifest...');
  const response = await imageBuildApi('/manifest');
  if (!response.ok) throw new Error('Custom image manifest unavailable');
  config.containers[0].images = assembleImageMap(image, await response.json(), config.account_id, catalog);
  shutdown.signal.throwIfAborted();
  // Keep relative Worker paths rooted in backend, without modifying tracked config.
  writeFileSync(temporaryConfig, JSON.stringify(config, null, 2));
  console.log(`Deploying ${Object.keys(config.containers[0].images).length} published container images; Cloudflare prepares each image before publication (10-minute timeout).`);
  console.log(`Terminal image: ${image}`);
  process.exitCode = await deployWithWrangler();
} catch (error) {
  if (!shutdownSignal) console.error(error.message);
  process.exitCode = shutdownSignal ? (shutdownSignal === 'SIGINT' ? 130 : 143) : 1;
} finally {
  try { unlinkSync(temporaryConfig); } catch (error) {
    if (error.code !== 'ENOENT') { console.error(error.message); process.exitCode = 1; }
  }
  if (releaseLease) {
    try {
      console.log('Releasing image deployment lease...');
      const response = await imageBuildApi('/deployment-lock', 'DELETE', { token: lease });
      if (!response.ok) throw new Error('Could not release image deployment lease');
      console.log('Image deployment lease released.');
    } catch (error) { console.error(`${error.message}. The lease will expire within 12 minutes.`); process.exitCode = 1; }
  }
  if (shutdownSignal) process.exitCode = shutdownSignal === 'SIGINT' ? 130 : 143;
}

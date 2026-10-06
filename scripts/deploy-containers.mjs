import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseEnv } from 'node:util';
import { assembleImageMap, imageBuildApi } from './custom-images.mjs';
import { validateImage } from './terminal-image.mjs';
import { validateCatalogImages } from './catalog-images.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const repository = 'mainbrella/backend';
const config = JSON.parse(readFileSync(join(root, 'wrangler.containers.jsonc'), 'utf8'));
const dockerfileHash = createHash('sha256').update(readFileSync(join(root, 'containers/Dockerfile'))).digest('hex');
const args = process.argv.slice(2);
// Keep deployment arguments from replacing the generated config or account.
if (args.some(arg => !['--dry-run', '--without-activity'].includes(arg))) {
  console.error('Only --dry-run and --without-activity are supported. Use npm run deploy:containers.');
  process.exit(1);
}
// Bootstrap the runtime before the API exports AccountActivity. Activity delivery
// already tolerates a missing binding; the final deployment restores it.
if (args.includes('--without-activity')) {
  config.durable_objects.bindings = config.durable_objects.bindings.filter(binding => binding.name !== 'ACCOUNT_ACTIVITY');
  console.log('Activity delivery omitted for bootstrap. Finish with API, then normal container deployment.');
}
const wranglerArgs = args.filter(arg => arg !== '--without-activity');

let image;
let catalog;
try {
  const release = JSON.parse(execFileSync('gh', ['api', `repos/${repository}/releases/tags/terminal-image`], { encoding: 'utf8', cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }));
  const asset = release.assets.find(asset => asset.name === 'terminal-image.json');
  if (!asset) throw new Error('missing image manifest');
  const manifest = JSON.parse(execFileSync('gh', ['api', `repos/${repository}/releases/assets/${asset.id}`, '-H', 'Accept: application/octet-stream'], { encoding: 'utf8', cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }));
  image = validateImage(manifest, config.account_id, dockerfileHash);
  const catalogAsset = release.assets.find(asset => asset.name === 'catalog-images.json');
  if (!catalogAsset) throw new Error('Catalog images have not been published. Run the Build MainBrella images workflow first.');
  const catalogManifest = JSON.parse(execFileSync('gh', ['api', `repos/${repository}/releases/assets/${catalogAsset.id}`, '-H', 'Accept: application/octet-stream'], { encoding: 'utf8', cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }));
  catalog = validateCatalogImages(catalogManifest, config.account_id, root);
  if (catalog.terminal.image !== image) throw new Error('Catalog and terminal manifests differ. Run the Build MainBrella images workflow first.');
} catch (error) {
  console.error(error.code === 'ENOENT' ? 'Install GitHub CLI (gh) and run gh auth login.' :
    `Cannot use the published images: ${/^(Image |Catalog |Incomplete |Invalid )/.test(error.message) ? error.message : 'release unavailable; check gh auth status and the Build MainBrella images workflow.'}`);
  console.error(`Run the Build MainBrella images workflow at https://github.com/${repository}/actions, then retry.`);
  process.exit(1);
}
// Read the authoritative map under a deployment lease. Never silently deploy an
// empty or stale release snapshot when the API is unavailable.
const lease = randomUUID();
let locked = false;
const temporaryConfig = join(root, `.wrangler-containers-${randomUUID()}.json`);
try {
  // Node does not load Wrangler's local .env automatically. Import only the
  // shared image secret, preserving any explicit shell/Actions value.
  if (process.env.IMAGE_BUILD_SECRET === undefined) {
    try {
      const local = parseEnv(readFileSync(join(root, '.env'), 'utf8'));
      if (local.IMAGE_BUILD_SECRET !== undefined) process.env.IMAGE_BUILD_SECRET = local.IMAGE_BUILD_SECRET;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!args.includes('--dry-run')) {
    const deadline = Date.now() + 8 * 60_000;
    while (true) {
      const result = await imageBuildApi('/deployment-lock', 'POST', { token: lease });
      if (result.ok) { locked = true; break; }
      if (result.status !== 409 || Date.now() >= deadline) throw new Error('Image deployment is busy or unavailable');
      await new Promise(resolve => setTimeout(resolve, 10_000));
    }
  }
  const response = await imageBuildApi('/manifest');
  if (!response.ok) throw new Error('Custom image manifest unavailable');
  config.containers[0].images = assembleImageMap(image, await response.json(), config.account_id, catalog);
  // Keep relative Worker paths rooted in backend, without modifying tracked config.
  writeFileSync(temporaryConfig, JSON.stringify(config, null, 2));
  console.log(`Deploying terminal image ${image}`);
  const result = spawnSync(process.execPath, [join(root, 'node_modules/wrangler/bin/wrangler.js'), 'deploy', '--config', temporaryConfig, ...wranglerArgs], { cwd: root, stdio: 'inherit', timeout: 10 * 60_000, killSignal: 'SIGKILL' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  try { unlinkSync(temporaryConfig); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (locked) {
    try {
      const response = await imageBuildApi('/deployment-lock', 'DELETE', { token: lease });
      if (!response.ok) throw new Error('Could not release image deployment lease');
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}

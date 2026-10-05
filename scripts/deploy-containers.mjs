import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateImage } from './terminal-image.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const repository = 'mainbrella/backend';
const config = JSON.parse(readFileSync(join(root, 'wrangler.containers.jsonc'), 'utf8'));
const dockerfileHash = createHash('sha256').update(readFileSync(join(root, 'containers/Dockerfile'))).digest('hex');
const args = process.argv.slice(2);
// Keep deployment arguments from replacing the generated config or account.
if (args.some(arg => !['--dry-run'].includes(arg))) {
  console.error('Only --dry-run is supported. Use npm run deploy:containers.');
  process.exit(1);
}

let image;
try {
  const release = JSON.parse(execFileSync('gh', ['api', `repos/${repository}/releases/tags/terminal-image`], { encoding: 'utf8', cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }));
  const asset = release.assets.find(asset => asset.name === 'terminal-image.json');
  if (!asset) throw new Error('missing image manifest');
  const manifest = JSON.parse(execFileSync('gh', ['api', `repos/${repository}/releases/assets/${asset.id}`, '-H', 'Accept: application/octet-stream'], { encoding: 'utf8', cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }));
  image = validateImage(manifest, config.account_id, dockerfileHash);
} catch (error) {
  console.error(error.code === 'ENOENT' ? 'Install GitHub CLI (gh) and run gh auth login.' :
    `Cannot use the published terminal image: ${error.message.startsWith('Image ') ? error.message : 'release unavailable; check gh auth status and the Build terminal image workflow.'}`);
  console.error(`Run the Build terminal image workflow at https://github.com/${repository}/actions, then retry.`);
  process.exit(1);
}
config.containers[0].images.terminal = { image };
// Keep relative Worker/Dockerfile paths rooted in backend, and avoid modifying tracked config.
const temporaryConfig = join(root, `.wrangler-containers-${randomUUID()}.json`);
try {
  writeFileSync(temporaryConfig, JSON.stringify(config, null, 2));
  console.log(`Deploying terminal image ${image}`);
  const result = spawnSync(process.execPath, [join(root, 'node_modules/wrangler/bin/wrangler.js'), 'deploy', '--config', temporaryConfig, ...args], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  unlinkSync(temporaryConfig);
}

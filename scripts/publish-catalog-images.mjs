import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IMAGE_CATALOG } from '../containers/image-catalog.js';
import { catalogSourceHash, validateCatalogImage } from './catalog-images.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!/^[a-f0-9]{32}$/.test(accountId || '')) throw new Error('Set CLOUDFLARE_ACCOUNT_ID');
const repository = 'mainbrella/backend';
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: root, ...options });
let previous = { images: {} };
try {
  const release = JSON.parse(run('gh', ['api', `repos/${repository}/releases/tags/terminal-image`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const asset = release.assets.find(asset => asset.name === 'catalog-images.json');
  if (asset) previous = JSON.parse(run('gh', ['api', `repos/${repository}/releases/assets/${asset.id}`, '-H', 'Accept: application/octet-stream'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
} catch { /* The initial catalog has no published manifest. */ }
const force = process.env.REBUILD_IMAGES === 'true' || process.env.GITHUB_EVENT_NAME === 'schedule';
const images = {};
for (const entry of IMAGE_CATALOG) {
  const dockerfileHash = catalogSourceHash(root, entry);
  if (!force) {
    try {
      const saved = previous.images?.[entry.key];
      validateCatalogImage(entry, saved, accountId, dockerfileHash);
      images[entry.key] = saved;
      console.log(`Reusing published ${entry.name}`);
      continue;
    } catch { /* Rebuild a changed, missing, or invalid image. */ }
  }
  const tag = `${entry.repository}:${process.env.GITHUB_RUN_ID || 'local'}`;
  run('docker', ['build', '--pull', '--platform', 'linux/amd64', '--provenance=false', '-f', entry.dockerfile, '-t', tag, 'containers'], { stdio: 'inherit', timeout: 12 * 60_000 });
  const check = `command -v sleep; bash --version; git --version; command -v ssh; test -f /etc/tmux.conf; tmux -V; tmux new-session -d -s smoke; tmux has-session -t smoke; ${entry.smoke}`;
  run('docker', ['run', '--rm', '--network', 'none', '--entrypoint', '/bin/sh', tag, '-ec', check], { stdio: 'inherit', timeout: 60_000 });
  run(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'containers', 'push', tag, '--config', 'wrangler.containers.jsonc'], { stdio: 'inherit' });
  const registry = `registry.cloudflare.com/${accountId}/${tag}`;
  const manifest = JSON.parse(run('docker', ['manifest', 'inspect', '--verbose', registry], { encoding: 'utf8' }));
  const digest = manifest.Descriptor?.digest;
  if (!/^sha256:[a-f0-9]{64}$/.test(digest || '')) throw new Error(`Missing ${entry.id} image digest`);
  images[entry.key] = { image: `registry.cloudflare.com/${accountId}/${entry.repository}@${digest}`, dockerfileHash };
}
writeFileSync(join(root, 'catalog-images.json'), JSON.stringify({ images }, null, 2));
writeFileSync(join(root, 'terminal-image.json'), JSON.stringify({ ...images.terminal, commit: process.env.GITHUB_SHA }, null, 2));

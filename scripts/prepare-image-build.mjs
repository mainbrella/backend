import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateImage } from './terminal-image.mjs';
import { prepareImageInputs } from './image-build-inputs.mjs';

const id = process.env.BUILD_ID;
if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id || '')) throw new Error('Invalid build ID');
const secret = process.env.IMAGE_BUILD_SECRET;
if (!secret || secret.length < 32) throw new Error('Missing build secret');
const dockerConfig = mkdtempSync(join(tmpdir(), 'mainbrella-image-auth-'));
try {
const response = await fetch(`https://api.mainbrella.com/internal/image-builds/${id}/source`, {
  method: 'POST', headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(20_000),
});
if (!response.ok) throw new Error('Build source unavailable');
const source = await response.json();
mkdirSync('prepared', { recursive: true });
const accountId = '2b7a9be82bb64187230703b024e25157';
await prepareImageInputs({ source, accountId, write: writeFileSync,
  run: (command, args, options = {}) => execFileSync(command, args, { timeout: 120_000,
    env: { ...process.env, DOCKER_CONFIG: dockerConfig }, stdio: ['pipe', 'pipe', 'pipe'], ...options }),
  cloudflareCredentials: async () => JSON.parse(execFileSync('npx', ['wrangler', 'containers', 'registries', 'credentials', '--pull', '--json', '--config', 'wrangler.containers.jsonc'], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] })),
  defaultBase: async () => {
    const manifest = JSON.parse(execFileSync('gh', ['release', 'view', 'terminal-image', '--repo', 'mainbrella/backend', '--json', 'assets'], { encoding: 'utf8', timeout: 30_000 }));
    const asset = manifest.assets.find(asset => asset.name === 'terminal-image.json');
    if (!asset) throw new Error('Missing base image manifest');
    const base = JSON.parse(execFileSync('gh', ['api', `repos/mainbrella/backend/releases/assets/${asset.id}`, '-H', 'Accept: application/octet-stream'], { encoding: 'utf8', timeout: 30_000 }));
    return validateImage(base, accountId, createHash('sha256').update(readFileSync('containers/Dockerfile')).digest('hex'));
  },
});
} catch {
  // A pull/login failure can contain passwords, repository names and tokens.
  // Do not emit child-process exceptions or upload partial preparation files.
  rmSync('prepared', { recursive: true, force: true });
  console.error('Image preparation failed. Verify image access, digest, size and service configuration.');
  process.exitCode = 1;
} finally { rmSync(dockerConfig, { recursive: true, force: true }); }

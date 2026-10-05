import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { validateImage } from './terminal-image.mjs';

const id = process.env.BUILD_ID;
if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id || '')) throw new Error('Invalid build ID');
const secret = process.env.IMAGE_BUILD_SECRET;
if (!secret || secret.length < 32) throw new Error('Missing build secret');
const response = await fetch(`https://api.mainbrella.com/internal/image-builds/${id}/source`, {
  method: 'POST', headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(20_000),
});
if (!response.ok) throw new Error('Build source unavailable');
const source = await response.json();
mkdirSync('prepared', { recursive: true });
writeFileSync('prepared/source.json', JSON.stringify(source));
const manifest = JSON.parse(execFileSync('gh', ['release', 'view', 'terminal-image', '--repo', 'mainbrella/backend', '--json', 'assets'], { encoding: 'utf8' }));
const asset = manifest.assets.find(asset => asset.name === 'terminal-image.json');
if (!asset) throw new Error('Missing base image manifest');
const base = JSON.parse(execFileSync('gh', ['api', `repos/mainbrella/backend/releases/assets/${asset.id}`, '-H', 'Accept: application/octet-stream'], { encoding: 'utf8' }));
const accountId = '2b7a9be82bb64187230703b024e25157';
const digest = validateImage(base, accountId, createHash('sha256').update(readFileSync('containers/Dockerfile')).digest('hex'));
const credentials = JSON.parse(execFileSync('npx', ['wrangler', 'containers', 'registries', 'credentials', '--pull', '--json', '--config', 'wrangler.containers.jsonc'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
execFileSync('docker', ['login', 'registry.cloudflare.com', '--username', credentials.username, '--password-stdin'], { input: credentials.password, stdio: ['pipe', 'ignore', 'pipe'] });
try {
  execFileSync('docker', ['pull', '--platform', 'linux/amd64', digest], { stdio: ['ignore', 'ignore', 'pipe'] });
  execFileSync('docker', ['tag', digest, 'mainbrella:base']);
  execFileSync('docker', ['save', '-o', 'prepared/base.tar', 'mainbrella:base']);
} finally { execFileSync('docker', ['logout', 'registry.cloudflare.com'], { stdio: 'ignore' }); }

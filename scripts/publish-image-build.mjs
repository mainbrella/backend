import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const id = process.env.BUILD_ID;
if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id || '')) throw new Error('Invalid build ID');
const secret = process.env.IMAGE_BUILD_SECRET;
if (!secret || secret.length < 32) throw new Error('Missing build secret');
const url = `https://api.mainbrella.com/internal/image-builds/${id}/status`;
const logs = existsSync('result/build.log') ? readFileSync('result/build.log', 'utf8').slice(-60000) : 'Build preparation failed. Check service configuration and submit a new build.';
async function api(path, body) {
  const response = await fetch(path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error === 'image_publication_busy' ? 'image_publication_busy' : 'Build status update unavailable');
  return result;
}
try {
  if (process.env.BUILD_RESULT !== 'success' || !existsSync('result/image.tar')) {
    await api(url, { status: 'failed', logs });
    process.exitCode = 1;
  } else {
    // Load and publish an image artifact. Never execute it in this privileged job.
    execFileSync('docker', ['load', '-i', 'result/image.tar'], { stdio: ['ignore', 'ignore', 'pipe'] });
    const tag = `mainbrella-custom-${id}:build`;
    execFileSync('docker', ['tag', 'mainbrella-custom:build', tag]);
    execFileSync('npx', ['wrangler', 'containers', 'push', tag, '--config', 'wrangler.containers.jsonc'], { stdio: ['ignore', 'inherit', 'pipe'] });
    const accountId = '2b7a9be82bb64187230703b024e25157';
    const registry = `registry.cloudflare.com/${accountId}/mainbrella-custom-${id}:build`;
    const manifest = JSON.parse(execFileSync('docker', ['manifest', 'inspect', '--verbose', registry], { encoding: 'utf8' }));
    const digest = manifest.Descriptor?.digest;
    if (!/^sha256:[a-f0-9]{64}$/.test(digest || '')) throw new Error('Missing image digest');
    const publication = { status: 'publishing', image: `registry.cloudflare.com/${accountId}/mainbrella-custom-${id}@${digest}`, logs };
    const waitUntil = Date.now() + 8 * 60_000;
    while (true) {
      try { await api(url, publication); break; }
      catch (error) {
        if (error.message !== 'image_publication_busy' || Date.now() >= waitUntil) throw error;
        await new Promise(resolve => setTimeout(resolve, 10_000));
      }
    }
    execFileSync(process.execPath, ['scripts/deploy-containers.mjs'], { stdio: ['ignore', 'inherit', 'pipe'] });
    await api(url, { status: 'ready', logs });
  }
} catch {
  await api(url, { status: 'failed', logs: `${logs}\nImage publication failed. Please contact support or submit a new build.` }).catch(() => {});
  // Do not echo child-process errors: they can contain registry credentials or user output.
  console.error('Custom image publication failed');
  process.exitCode = 1;
}

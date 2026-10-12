import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// Uses the same token and exact service metadata endpoint as image deployment.
// GET success proves visibility only, never deployment, registry or build rights.
export async function imageAccessPreflight({ config, env, request = fetch }) {
  if (config?.name !== 'mainbrella-containers' || !/^[a-f0-9]{32}$/.test(config.account_id ?? '')) {
    throw new Error('Image deployment requires the pinned mainbrella-containers Worker and account.');
  }
  if (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_ACCOUNT_ID !== config.account_id) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID differs from wrangler.containers.jsonc.');
  }
  if (typeof env.CLOUDFLARE_API_TOKEN !== 'string' || !env.CLOUDFLARE_API_TOKEN.trim()) {
    throw new Error('Set the dedicated CLOUDFLARE_API_TOKEN used by the image workflow. Local Wrangler login does not validate the GitHub Actions secret.');
  }
  let response, body;
  try {
    response = await request(`https://api.cloudflare.com/client/v4/accounts/${config.account_id}/workers/services/${config.name}`, {
      method: 'GET', headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
      redirect: 'error', signal: AbortSignal.timeout(20_000),
    });
    body = await response.json();
  } catch {
    throw new Error('Cannot read Cloudflare service metadata with the image workflow token. Check token availability and Cloudflare connectivity; no resources were changed.');
  }
  if (!response.ok || body?.success !== true || typeof body.result?.default_environment?.script?.tag !== 'string') {
    const status = Number.isInteger(response.status) ? ` (HTTP ${response.status})` : '';
    throw new Error(`Image workflow token cannot read mainbrella-containers in the configured account${status}. Check the token account, expiry, IP restrictions and Workers scope; deployment needs Editor access to this existing Worker. Do not replace the service or change its Durable Object bindings. No resources were changed.`);
  }
  return { accountId: config.account_id, worker: config.name, serviceMetadataReadable: true, deploymentQualified: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) throw new Error('Image access preflight takes no arguments and uses wrangler.containers.jsonc.');
    const config = JSON.parse(readFileSync(fileURLToPath(new URL('../wrangler.containers.jsonc', import.meta.url)), 'utf8'));
    console.log(JSON.stringify(await imageAccessPreflight({ config, env: process.env })));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

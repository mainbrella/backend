import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

export function importAppManifest(redirectURL) {
  return { name: 'Mainbrella Import', description: 'Read-only access to selected repositories for Mainbrella cloud workspaces. Publishing changes uses a separate Build app.',
    url: 'https://mainbrella.com/try/', redirect_url: redirectURL,
    callback_urls: ['https://api.mainbrella.com/github/import/callback', 'http://localhost:8787/github/import/callback'],
    setup_url: 'https://api.mainbrella.com/github/import/setup', public: true,
    default_permissions: { contents: 'read', metadata: 'read' }, default_events: [],
    hook_attributes: { url: 'https://api.mainbrella.com/github/import/events', active: false },
    request_oauth_on_install: false, setup_on_update: true };
}
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export async function startRegistration({ owner = 'mainbrella', port = 43187, provision = false } = {}) {
  if (!/^[A-Za-z0-9-]+$/.test(owner)) throw new Error('Invalid GitHub organization.');
  const state = randomBytes(32).toString('hex');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const base = `http://127.0.0.1:${port}`;
  const manifest = importAppManifest(`${base}/callback`);
  let finished = false;
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.setHeader('X-Content-Type-Options', 'nosniff');
    if (request.headers.host !== `127.0.0.1:${port}` || request.method !== 'GET') { response.writeHead(403); response.end('Forbidden'); return; }
    const url = new URL(request.url, base);
    if (url.pathname === `/register/${state}`) {
      const action = `https://github.com/organizations/${owner}/settings/apps/new?state=${state}`;
      response.end(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>Create Mainbrella Import</title><body><h1>Create Mainbrella Import</h1><p>Register the app under ${escape(owner)} with read-only Contents and Metadata permissions. No write access or webhooks.</p><form action="${escape(action)}" method="post"><input type="hidden" name="manifest" value="${escape(JSON.stringify(manifest))}"><button type="submit">Create app on GitHub</button></form></body></html>`);
      return;
    }
    if (url.pathname !== '/callback' || url.searchParams.get('state') !== state || !/^[A-Za-z0-9_-]{1,256}$/.test(url.searchParams.get('code') ?? '') || finished) {
      response.writeHead(400); response.end('Invalid or already used registration.'); return;
    }
    finished = true;
    try {
      const conversion = await fetch(`https://api.github.com/app-manifests/${url.searchParams.get('code')}/conversions`, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15_000),
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Mainbrella-Import-registration', 'X-GitHub-Api-Version': '2026-03-10' } });
      const app = await conversion.json();
      if (!conversion.ok || !app.client_id || !app.client_secret || !/^[A-Za-z0-9-]+$/.test(app.slug)) throw new Error('GitHub registration conversion failed.');
      const secrets = { GITHUB_IMPORT_CLIENT_ID: app.client_id, GITHUB_IMPORT_CLIENT_SECRET: app.client_secret,
        GITHUB_IMPORT_APP_SLUG: app.slug, GITHUB_IMPORT_ENCRYPTION_KEY: randomBytes(32).toString('hex') };
      const secretFile = `${root}.github-import-secrets.json`;
      // Never print credentials, retain a private key unnecessarily, or overwrite existing secrets.
      await writeFile(secretFile, JSON.stringify(secrets, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      if (provision) await new Promise((resolve, reject) => {
        const child = spawn('npx', ['wrangler', 'secret', 'bulk', secretFile, '--config', 'wrangler.jsonc'], { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] });
        child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error('Credential provisioning failed; credentials are saved locally.')));
      });
      console.log(`Registered GitHub App: https://github.com/apps/${app.slug}`);
      console.log(provision ? 'Credentials provisioned to the API Worker. Deploy the validated integration and apply migration 028.' : 'Credentials saved in .github-import-secrets.json (mode 0600); provision with wrangler secret bulk.');
      response.end(`<html lang="en"><title>Import app created</title><body><h1>Mainbrella Import created</h1><p>Credentials were saved securely${provision ? ' and provisioned to the API Worker' : ''}. Apply migration 028 and deploy the API and web integration before installing the app.</p><a href="https://github.com/apps/${escape(app.slug)}">View the app</a></body></html>`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'Registration failed.');
      response.writeHead(502); response.end('Registration could not finish. Check the local command output; credentials, if generated, remain in the protected local file.');
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  console.log(`Register the read-only app: ${base}/register/${state}`);
  return server;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const ownerIndex = args.indexOf('--owner');
  if (args.some((arg, index) => !['--owner', '--provision'].includes(arg) && index !== ownerIndex + 1)) throw new Error('Usage: npm run github:register-import -- [--owner organization] [--provision]');
  await startRegistration({ owner: ownerIndex >= 0 ? args[ownerIndex + 1] : 'mainbrella', provision: args.includes('--provision') });
}

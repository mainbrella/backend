import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { resolveTool } from './resolve-tool.mjs';

// Deliberately separate from the normal deploy: private service provisioning
// does not enable customer access or replace the runtime's published image map.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { values } = parseArgs({ options: { 'api-account': { type: 'string' } } });
if (values['api-account']) assert.match(values['api-account'], /^[A-Za-z0-9_-]{1,128}$/, 'An exact account ID is required');
const path = join(root, '.wrangler/security-service-credentials.json'); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
let settings;
try { settings = JSON.parse(await readFile(path, 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  settings = { schemaVersion: 1, relayToken: randomBytes(32).toString('hex'), ackControlToken: randomBytes(32).toString('hex'), encryptionKey: randomBytes(32).toString('base64'), versions: {}, installed: {} };
  await writeFile(path, JSON.stringify(settings, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
assert.equal((await stat(path)).mode & 0o077, 0, 'Credential file must be private');
for (const value of [settings.relayToken, settings.ackControlToken]) assert.match(value, /^[a-f0-9]{64}$/);
assert.equal(Buffer.from(settings.encryptionKey, 'base64').length, 32);
const persist = () => writeFile(path, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
const scan = output => {
  for (const value of [settings.relayToken, settings.ackControlToken, settings.encryptionKey]) assert.equal(output.includes(value), false, 'Wrangler output contained a credential');
};
async function wrangler(args, input) {
  const child = spawn(process.execPath, [resolveTool('wrangler', 'bin/wrangler.js'), ...args], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
  child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  const timeout = setTimeout(() => child.kill('SIGTERM'), 240000);
  const progress = setInterval(() => console.log(`Security service operation: ${args[0]} ${args[1] ?? ''} is still running.`), 30000);
  try {
    const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); });
    scan(stdout + stderr);
    if (code !== 0) { console.error(stderr || stdout); throw new Error('Security service operation failed'); }
    return stdout;
  } finally { clearTimeout(timeout); clearInterval(progress); }
}
async function currentVersion(config) {
  const deployments = JSON.parse(await wrangler(['deployments', 'list', '--config', config, '--json']));
  const latest = deployments.at(-1); assert.equal(latest.versions.length, 1, 'Canary requires a single deployed version');
  const id = latest.versions[0].version_id; assert.match(id, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/); return id;
}
async function install(config, secrets, name) {
  const existing = JSON.parse(await wrangler(['secret', 'list', '--config', config, '--format', 'json']));
  // An existing encryption key may protect real data. Never replace a key whose
  // installation was not recorded in this operator's private credential file.
  assert.ok(!existing.some(item => Object.hasOwn(secrets, item.name)) || settings.installed[name], 'Existing security secrets require their original operator credential file');
  settings.installed[name] = { attemptedAt: new Date().toISOString() }; await persist();
  await wrangler(['secret', 'bulk', '--config', config], secrets);
  settings.installed[name].completedAt = new Date().toISOString(); await persist();
}
if (!values['api-account']) {
  for (const [name, config, secrets] of [
    ['relay', 'wrangler.egress-relay.jsonc', { EGRESS_RELAY_TOKEN: settings.relayToken }],
    ['ack', 'wrangler.security-ack.jsonc', { SECURITY_ACK_CONTROL_TOKEN: settings.ackControlToken }],
  ]) {
    console.log(`Deploying dedicated ${name} service...`);
    const deployment = await wrangler(['deploy', '--config', config]);
    const urls = deployment.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/g) ?? [];
    assert.equal(urls.length, 1, 'Expected one service URL'); settings[`${name}Origin`] = urls[0]; await persist();
    await install(config, secrets, name); settings.versions[name] = await currentVersion(config); await persist();
    console.log(`${name}: ${urls[0]} (${settings.versions[name]})`);
  }
  await install('wrangler.jsonc', { EGRESS_RELAY_TOKEN: settings.relayToken, EGRESS_RELAY_URL: settings.relayOrigin + '/v1/egress', SECRETS_ENCRYPTION_KEY: settings.encryptionKey }, 'api');
  console.log('Dedicated services configured. Customer security flags remain at their current settings.');
} else {
  assert.ok(settings.installed.api?.completedAt && settings.versions.relay && settings.versions.ack, 'Provision dedicated services first');
  console.log(`Deploying security API access for account ${values['api-account']}...`);
  const args = ['deploy', '--config', 'wrangler.jsonc', '--var', 'EGRESS_POLICIES_ENABLED:true', '--var', 'SECRETS_VAULT_ENABLED:true', '--var', `SECURITY_FEATURE_ACCOUNTS:${values['api-account']}`];
  const deployed = await wrangler(args); console.log(deployed);
  settings.versions.api = await currentVersion('wrangler.jsonc'); settings.versions.runtime = await currentVersion('wrangler.containers.jsonc');
  settings.account = values['api-account']; await persist();
  console.log('Production API enabled for the private qualification account. Tracked flags remain disabled for normal deployments.');
}

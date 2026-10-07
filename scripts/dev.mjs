import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// Keep bindings and variables in sync with the deployment configuration, while
// preventing Wrangler from rewriting local preview hosts to the deployed route.
const configPaths = ['api', 'containers'].map(name => {
  const source = name === 'api' ? 'wrangler.jsonc' : 'wrangler.containers.jsonc';
  const config = JSON.parse(readFileSync(`${root}${source}`, 'utf8'));
  delete config.routes;
  delete config.route;
  config.vars = { ...config.vars, LOCAL_DEV: 'true' };
  const path = `${root}.wrangler-local-${name}-${process.pid}.jsonc`;
  writeFileSync(path, JSON.stringify(config, null, 2));
  return path;
});
const child = spawn(`${root}node_modules/.bin/wrangler`, [
  'dev', '--local', ...configPaths.flatMap(path => ['--config', path]), ...process.argv.slice(2),
], { cwd: root, stdio: 'inherit' });
process.on('exit', () => { for (const path of configPaths) unlinkSync(path); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { child.kill(signal); });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });

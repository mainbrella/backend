import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--out')) throw new Error('Usage: npm run docs:package -- [--out <new directory>]');
const output = resolve(args[1] || join(root, 'artifacts/agent-reference'));
await mkdir(dirname(output), { recursive: true });
await mkdir(output);
const version = JSON.parse(await readFile(join(root, 'sdk/javascript/package.json'), 'utf8')).version;
const skillDir = join(output, 'mainbrella-containers');
await mkdir(join(skillDir, 'references'), { recursive: true });
const sources = {
  'API.md': 'API.md', 'SKILL.md': 'SKILL.md',
  'sdk/javascript.md': 'sdk/javascript/README.md', 'sdk/python.md': 'sdk/python/README.md',
};
const documents = {};
for (const [name, path] of Object.entries(sources)) documents[name] = await readFile(join(root, path), 'utf8');
const references = {};
const sections = documents['API.md'].split(/(?=^## )/m).slice(1);
for (const section of sections) {
  const title = section.split('\n')[0].slice(3);
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const name = `references/${slug}.md`;
  if (references[name]) throw new Error('Duplicate reference slug');
  references[name] = `<!-- Generated from backend/API.md; edit the source and run docs:package. -->\n${section.trim()}\n`;
}
references['references/javascript-sdk.md'] = documents['sdk/javascript.md'];
references['references/python-sdk.md'] = documents['sdk/python.md'];
references['references/index.md'] = `# Mainbrella reference index\n\nGenerated from backend API.md and SDK READMEs. Local implementation does not establish deployed support; read /capabilities before using a feature.\n\n${Object.entries(references).map(([name, content]) => `- [${content.match(/^#+ (.+)$/m)?.[1]}](${name.slice('references/'.length)})`).join('\n')}\n`;
for (const [name, content] of Object.entries({ 'API.md': documents['API.md'], 'SKILL.md': documents['SKILL.md'], ...references })) {
  await writeFile(join(skillDir, name), content);
}
await copyFile(join(root, 'LICENSE'), join(skillDir, 'LICENSE'));
const full = `# Mainbrella full agent reference\n\nGenerated from the backend's authoritative API, skill and SDK instructions. SDKs are unpublished; deployment capabilities must be checked independently.\n\n${Object.entries(documents).map(([name, content]) => `<!-- Source: https://mainbrella.com/${name} -->\n\n${content}`).join('\n\n')}\n`;
await writeFile(join(output, 'llms-full.txt'), full);
const files = { ...documents, ...references, 'llms-full.txt': full };
const manifest = { version, source: 'mainbrella/backend', licenseSha256: createHash('sha256').update(await readFile(join(root, 'LICENSE'))).digest('hex'), files: Object.fromEntries(Object.entries(files).map(([name, value]) =>
  [name, createHash('sha256').update(value).digest('hex')])) };
await writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const archive = join(output, `mainbrella-containers-${version}.tar.gz`);
const result = spawnSync('tar', ['-czf', archive, '-C', output, 'mainbrella-containers'], { stdio: 'inherit' });
if (result.error || result.status !== 0) throw new Error('Skill archive failed');
console.log(`Agent reference package: ${output}`);

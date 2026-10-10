// This program runs with native Git on local container disk. Its snapshot is
// supplied by the Worker, independently of application scripts and Git config.
export const buildGitProgram = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const base = path.dirname(process.argv[2]);
const repo = path.join(base, 'repository');
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Mainbrella', GIT_AUTHOR_EMAIL: 'build@mainbrella.invalid',
  GIT_COMMITTER_NAME: 'Mainbrella', GIT_COMMITTER_EMAIL: 'build@mainbrella.invalid',
  GIT_AUTHOR_DATE: input.date, GIT_COMMITTER_DATE: input.date };
for (const key of ['GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES','GIT_CONFIG_COUNT']) delete env[key];
function git(args, cwd = repo, accept = [0]) {
  const result = spawnSync('git', ['-c','core.hooksPath=/dev/null','-c','core.autocrlf=false',
    '-c','commit.gpgsign=false','-c','protocol.file.allow=always', ...args], { cwd, env, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (!accept.includes(result.status)) throw new Error('Git failed: ' + (result.stderr || result.error || result.status));
  return result;
}
function installGit() {
  const destination = path.join(input.worktree, '.git');
  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(path.join(repo, '.git'), destination, { recursive: true });
  fs.writeFileSync(path.join(input.worktree, '.gitignore'), 'node_modules/\ndist/\n.env\n.env.*\n');
}
fs.rmSync(repo, { recursive: true, force: true });
fs.mkdirSync(repo, { recursive: true });
if (input.parent) {
  const bundle = path.join(base, 'parent.bundle');
  const fd = fs.openSync(bundle, 'w');
  try {
    for (const [index, part] of input.parent.parts.entries()) {
      const bytes = fs.readFileSync(path.join(base, 'parts', String(index)));
      if (bytes.length !== part.size || crypto.createHash('sha256').update(bytes).digest('hex') !== part.sha256) throw new Error('Invalid bundle part');
      fs.writeSync(fd, bytes);
    }
  } finally { fs.closeSync(fd); }
  git(['clone','--quiet','--branch','main',bundle,repo], base);
  if (git(['rev-parse','HEAD']).stdout.trim() !== input.parent.commitId) throw new Error('Invalid repository head');
} else git(['init','--quiet','--initial-branch=main']);
if (input.action === 'hydrate') {
  installGit();
  process.stdout.write(JSON.stringify({ ok: true }));
} else {
  for (const name of fs.readdirSync(repo)) if (name !== '.git') fs.rmSync(path.join(repo, name), { recursive: true, force: true });
  for (const name of input.paths) {
    if (path.isAbsolute(name) || name.split('/').some(part => !part || part === '.' || part === '..' || part === '.git')) throw new Error('Invalid snapshot path');
    const source = path.join(base, 'snapshot', name);
    if (!fs.lstatSync(source).isFile()) throw new Error('Invalid snapshot file');
    const destination = path.join(repo, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  git(['add','--all']);
  if (!input.parent || input.force || git(['diff','--cached','--quiet'], repo, [0,1]).status === 1) git(['commit','--quiet','--allow-empty','-m',input.message]);
  const commitId = git(['rev-parse','HEAD']).stdout.trim();
  const bundle = path.join(base, 'repository.bundle');
  git(['bundle','create',bundle,'main']);
  git(['bundle','verify',bundle]);
  const size = fs.statSync(bundle).size;
  if (size > 128 * 1024 * 1024) throw new Error('Repository exceeds bundle limit');
  const output = path.join(base, 'output');
  fs.rmSync(output, { recursive: true, force: true }); fs.mkdirSync(output);
  const fd = fs.openSync(bundle, 'r');
  const parts = [];
  try {
    for (let offset = 0; offset < size; offset += 1024 * 1024) {
      const bytes = Buffer.alloc(Math.min(1024 * 1024, size - offset));
      fs.readSync(fd, bytes, 0, bytes.length, offset);
      fs.writeFileSync(path.join(output, String(parts.length)), bytes);
      parts.push({ size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
    }
  } finally { fs.closeSync(fd); }
  installGit();
  process.stdout.write(JSON.stringify({ commitId, size, parts }));
}
`;

// This program runs with native Git on local container disk. Its snapshot is
// supplied by the Worker, independently of application scripts and Git config.
export const BUILD_GIT_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const buildGitProgram = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const base = path.dirname(process.argv[2]);
const repo = path.join(base, 'repository');
const marker = path.join(base, 'hydrated.json');
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
function reusable() {
  try {
    const saved = JSON.parse(fs.readFileSync(marker, 'utf8'));
    if (JSON.stringify(saved.identity) !== JSON.stringify(input.identity) || saved.commitId !== (input.parent?.commitId || null)) return false;
    const head = git(['rev-parse','--verify','HEAD'], repo, [0,128]);
    return input.parent ? head.status === 0 && head.stdout.trim() === input.parent.commitId : head.status === 128;
  } catch { return false; }
}
function remember(commitId) {
  fs.writeFileSync(marker, JSON.stringify({ identity: input.identity, commitId }));
}
if (input.action === 'publish') {
  if (!reusable()) throw new Error('Hydrated repository changed');
  installGit();
  process.stdout.write(JSON.stringify({ ok: true }));
  process.exit(0);
}
if (input.action === 'check') {
  process.stdout.write(JSON.stringify({ reusable: reusable() }));
  process.exit(0);
}
if (input.reuse || input.parent?.reuse) {
  if (!reusable()) throw new Error('Hydrated repository changed');
} else {
  fs.rmSync(marker, { force: true });
  fs.rmSync(repo, { recursive: true, force: true });
  fs.mkdirSync(repo, { recursive: true });
  for (const [bundleIndex, manifest] of (input.parent?.bundles || []).entries()) {
    const bundle = path.join(base, 'parent.bundle');
    const fd = fs.openSync(bundle, 'w');
    try {
      for (const [index, part] of manifest.parts.entries()) {
        const bytes = fs.readFileSync(path.join(base, 'parts', bundleIndex + '-' + index));
        if (bytes.length !== part.size || crypto.createHash('sha256').update(bytes).digest('hex') !== part.sha256) throw new Error('Invalid bundle part');
        fs.writeSync(fd, bytes);
      }
    } finally { fs.closeSync(fd); }
    const headerBytes = Buffer.alloc(Math.min(4096, fs.statSync(bundle).size));
    const headerFd = fs.openSync(bundle, 'r');
    try { fs.readSync(headerFd, headerBytes); } finally { fs.closeSync(headerFd); }
    const header = headerBytes.toString('utf8').split('\n\n')[0].split('\n');
    const prerequisites = header.filter(line => line.startsWith('-')).map(line => line.slice(1,41));
    const expected = manifest.schemaVersion === 2 && manifest.prerequisiteCommitId ? [manifest.prerequisiteCommitId] : [];
    if (header[0] !== '# v2 git bundle' || JSON.stringify(prerequisites) !== JSON.stringify(expected)
      || git(['bundle','list-heads',bundle], base).stdout.trim() !== manifest.commitId + ' refs/heads/main') throw new Error('Invalid bundle header');
    if (bundleIndex === 0) git(['clone','--quiet','--branch','main',bundle,repo], base);
    else {
      git(['bundle','verify',bundle]);
      git(['fetch','--quiet',bundle,'refs/heads/main']);
      git(['reset','--hard','FETCH_HEAD']);
    }
    if (git(['rev-parse','HEAD']).stdout.trim() !== manifest.commitId) throw new Error('Invalid repository head');
  }
  if (input.parent) {
    git(['merge-base','--is-ancestor',input.parent.commitId,'HEAD']);
    git(['reset','--hard',input.parent.commitId]);
  } else git(['init','--quiet','--initial-branch=main']);
}
if (input.action === 'hydrate') {
  remember(input.parent?.commitId || null);
  installGit();
  process.stdout.write(JSON.stringify({ ok: true }));
} else {
  for (const name of fs.readdirSync(repo)) if (name !== '.git') fs.rmSync(path.join(repo, name), { recursive: true, force: true });
  for (const name of input.paths) {
    if (path.isAbsolute(name) || name.split('/').some(part => !part || part === '.' || part === '..' || part === '.git')) throw new Error('Invalid snapshot path');
    const source = path.join(base, 'snapshot', name);
    const stat = fs.lstatSync(source);
    if (!stat.isFile()) throw new Error('Invalid snapshot file');
    if (stat.size > ${BUILD_GIT_MAX_FILE_BYTES}) throw new Error('build_git_file_limit: ' + name + ' exceeds 25 MiB');
    const destination = path.join(repo, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  git(['add','--all']);
  if (!input.parent || input.force || git(['diff','--cached','--quiet'], repo, [0,1]).status === 1) git(['commit','--quiet','--allow-empty','-m',input.message]);
  const commitId = git(['rev-parse','HEAD']).stdout.trim();
  if (commitId === input.parent?.commitId) {
    remember(commitId);
    process.stdout.write(JSON.stringify({ commitId, unchanged: true }));
    process.exit(0);
  }
  const bundle = path.join(base, 'repository.bundle');
  // Keep increments free of delta references between packed objects. Git may
  // re-emit old trees on a restore; competing delta representations of the
  // same object cannot safely be joined into one pack at download time.
  // Each object still has normal zlib compression, and old history is excluded.
  git([...(input.parent ? ['-c','pack.window=0','-c','pack.depth=0','-c','pack.allowPackReuse=false'] : []),
    'bundle','create','--version=2',bundle,'main',...(input.parent ? ['^' + input.parent.commitId] : [])]);
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
  remember(commitId);
  process.stdout.write(JSON.stringify({ commitId, size, parts }));
}
`;

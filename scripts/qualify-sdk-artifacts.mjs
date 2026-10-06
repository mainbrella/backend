import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--out')) {
  console.error('Usage: npm run sdk:qualify -- [--out <new artifact directory>]');
  process.exit(1);
}
const output = resolve(args[1] || join(root, 'artifacts/sdk'));
const pythonCommand = process.env.PYTHON || 'python3';
const work = await mkdtemp(join(tmpdir(), 'mainbrella-sdk-'));
let completed = false;
let createdOutput = false;

function run(command, argv, { cwd = work, env = {}, capture = false } = {}) {
  const result = spawnSync(command, argv, { cwd, env: { ...process.env, ...env },
    encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', timeout: 300_000 });
  if (result.error || result.status !== 0) {
    // Captured pack output contains no account credentials; this tool never calls the API.
    if (capture) process.stderr.write(result.stderr || '');
    throw new Error(`SDK qualification failed: ${command} ${argv[0]}`);
  }
  return result.stdout;
}

async function qualificationSources() {
  const paths = ['LICENSE', 'package.json', 'package-lock.json', 'scripts/qualify-sdk-artifacts.mjs',
    'scripts/qualify-python-artifact.py', 'scripts/sdk-build-requirements.txt', 'scripts/sdk-runtime-workflow.py', 'scripts/sdk-types.ts'];
  async function walk(directory) {
    for (const item of await readdir(join(root, directory), { withFileTypes: true })) {
      if (item.name.startsWith('.') || ['node_modules', '__pycache__', 'dist', 'build'].includes(item.name) || item.name.endsWith('.egg-info')) continue;
      const path = join(directory, item.name);
      if (item.isDirectory()) await walk(path);
      else if (item.isFile() && (/\.(js|mjs|ts|py|json|toml|md)$/.test(item.name) || item.name === 'LICENSE')) paths.push(path);
    }
  }
  for (const directory of ['sdk', 'containers', 'worker', 'experiments']) await walk(directory);
  return Promise.all([...new Set(paths)].sort().map(async path => ({ path,
    sha256: createHash('sha256').update(await readFile(join(root, path))).digest('hex') })));
}

async function stage(language, files) {
  const target = join(work, language);
  await mkdir(target);
  for (const file of files) {
    await mkdir(dirname(join(target, file)), { recursive: true });
    await copyFile(join(root, 'sdk', language, file), join(target, file));
  }
  // The repository license is authoritative. Never relicense a staged artifact.
  const license = await readFile(join(root, 'LICENSE'));
  assert.deepEqual(await readFile(join(root, 'sdk', language, 'LICENSE')), license, `${language} license has drifted`);
  await copyFile(join(root, 'LICENSE'), join(target, 'LICENSE'));
  return target;
}

try {
  const sourceFiles = await qualificationSources();
  for (const command of ['timeout', 'stat', 'find', 'sed']) {
    assert.ok(run(command, ['--version'], { capture: true }).includes('GNU'),
      `SDK runtime qualification requires GNU ${command} on PATH; use Linux or prepend its gnubin directory.`);
  }
  // Refuse to overwrite previously qualified evidence.
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output, { recursive: false });
  createdOutput = true;
  const js = await stage('javascript', ['package.json', 'README.md', 'index.js', 'index.d.ts', 'cli.mjs']);
  const py = await stage('python', ['pyproject.toml', 'README.md', 'mainbrella/__init__.py']);
  const metadata = JSON.parse(await readFile(join(js, 'package.json'), 'utf8'));
  const pyMetadata = await readFile(join(py, 'pyproject.toml'), 'utf8');
  assert.equal(metadata.version, pyMetadata.match(/^version = "([^"]+)"/m)?.[1], 'SDK versions differ');
  assert.equal(metadata.license, 'GPL-3.0-only');
  assert.ok(!metadata.dependencies || Object.keys(metadata.dependencies).length === 0);

  const pack = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', output], { cwd: js, capture: true }))[0];
  assert.deepEqual(pack.files.map(file => file.path).sort(), ['LICENSE', 'README.md', 'cli.mjs', 'index.d.ts', 'index.js', 'package.json']);
  const consumer = join(work, 'consumer');
  await mkdir(consumer);
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--offline', join(output, pack.filename)], { cwd: consumer });
  const installed = join(consumer, 'node_modules/@mainbrella/sdk');
  assert.equal(await readFile(join(installed, 'LICENSE'), 'utf8'), await readFile(join(root, 'LICENSE'), 'utf8'));
  await copyFile(join(root, 'sdk/javascript/client.test.mjs'), join(consumer, 'client.test.mjs'));
  await copyFile(join(root, 'sdk/javascript/cli.test.mjs'), join(consumer, 'cli.test.mjs'));
  run(process.execPath, ['--test', 'client.test.mjs', 'cli.test.mjs'], { cwd: consumer, env: { MAINBRELLA_SDK_MODULE: '@mainbrella/sdk', MAINBRELLA_SDK_CLI: pathToFileURL(join(installed, 'cli.mjs')).href } });
  assert.equal(run(join(consumer, 'node_modules/.bin/mainbrella'), ['--version'], { cwd: consumer, capture: true }).trim(), metadata.version);
  await copyFile(join(root, 'scripts/sdk-types.ts'), join(consumer, 'sdk-types.ts'));
  run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--target', 'ES2022',
    '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--lib', 'ES2022,DOM,DOM.Iterable', 'sdk-types.ts'], { cwd: consumer });
  const runtimeTest = join(root, 'worker/app/sdk-runtime.integration.test.ts');
  const installedModule = pathToFileURL(join(installed, 'index.js')).href;
  run(process.execPath, ['--import', join(root, 'node_modules/tsx/dist/loader.mjs'), '--test', runtimeTest],
    { cwd: root, env: { MAINBRELLA_SDK_MODULE: installedModule } });

  run(pythonCommand, ['-m', 'venv', join(work, 'build-env')]);
  const python = join(work, 'build-env', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', join(root, 'scripts/sdk-build-requirements.txt')]);
  run(python, ['-m', 'build', '--outdir', output, py]);
  run(python, ['-m', 'twine', 'check', ...((await readdir(output)).filter(file => /\.(whl|tar\.gz)$/.test(file)).map(file => join(output, file)))]);
  run(python, [join(root, 'scripts/qualify-python-artifact.py'), output, join(root, 'LICENSE'), metadata.version]);
  const tests = join(work, 'python-tests');
  await mkdir(tests);
  await copyFile(join(root, 'sdk/python/test_client.py'), join(tests, 'test_client.py'));
  for (const artifact of (await readdir(output)).filter(file => /\.(whl|tar\.gz)$/.test(file))) {
    const envDir = join(work, artifact.endsWith('.whl') ? 'wheel-env' : 'sdist-env');
    run(pythonCommand, ['-m', 'venv', envDir]);
    const executable = join(envDir, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    // Install the sdist with known build tools, then forbid runtime dependency downloads.
    if (artifact.endsWith('.tar.gz')) run(executable, ['-m', 'pip', 'install', '--disable-pip-version-check', 'setuptools>=77.0.3', 'wheel']);
    run(executable, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-index', '--no-deps', '--no-build-isolation', join(output, artifact)]);
    run(executable, ['-I', '-m', 'unittest', 'discover', '-s', tests, '-p', 'test_*.py']);
    run(process.execPath, ['--import', join(root, 'node_modules/tsx/dist/loader.mjs'), '--test', runtimeTest],
      { cwd: root, env: { MAINBRELLA_SDK_MODULE: installedModule, MAINBRELLA_SDK_PYTHON: executable } });
  }
  const artifacts = [];
  for (const name of (await readdir(output)).sort()) {
    const bytes = await readFile(join(output, name));
    artifacts.push({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  assert.deepEqual(await qualificationSources(), sourceFiles, "Qualification inputs changed during the run; rerun against stable sources.");
  const report = { sourceFiles, version: metadata.version, qualifiedAt: new Date().toISOString(), node: process.version,
    python: run(pythonCommand, ['--version'], { capture: true }).trim(),
    sourceRevision: run('git', ['rev-parse', 'HEAD'], { cwd: root, capture: true }).trim(),
    sourceDirty: Boolean(run('git', ['status', '--porcelain'], { cwd: root, capture: true }).trim()),
    buildTools: JSON.parse(run(python, ['-m', 'pip', 'list', '--format=json'], { capture: true })),
    checks: { packageContents: true, license: true, npmCleanInstall: true, typescript: true,
      wheelCleanInstall: true, sdistCleanInstall: true, sdkContractSuites: true, localRuntimeWorkflow: true, deployedWorkflow: false }, artifacts };
  await writeFile(join(output, 'qualification.json'), `${JSON.stringify(report, null, 2)}\n`);
  completed = true;
  console.log(`Qualified local SDK artifacts: ${output}. Deployed workflow and publication remain release gates.`);
} finally {
  await rm(work, { recursive: true, force: true });
  // Leave failed artifacts for inspection, with no success manifest.
  if (!completed && createdOutput) console.error(`Qualification incomplete; inspect artifacts at ${output}.`);
}

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const checksum = bytes => createHash('sha256').update(bytes).digest('hex');
const workflows = ['scripts/qualify-sdk-deployed.mjs', 'scripts/sdk-deployed-workflow.mjs', 'scripts/sdk-deployed-workflow.py'];
const localChecks = ['packageContents', 'license', 'npmCleanInstall', 'typescript', 'wheelCleanInstall',
  'sdistCleanInstall', 'sdkContractSuites', 'localRuntimeWorkflow'];
const workflowChecks = ['idempotentAdmission', 'stdoutStderr', 'binaryFiles', 'managedReconnect', 'cancellation'];

export function parseQualificationArgs(args, env = process.env) {
  const options = {};
  for (const arg of args) {
    const match = /^--(candidate|output|max-starts|api-revision|runtime-revision)=(.+)$/.exec(arg);
    if (!match || Object.hasOwn(options, match[1])) throw new Error('invalid_arguments');
    options[match[1]] = match[2];
  }
  if (!options.candidate || !options.output || options['max-starts'] !== '2'
    || !['api-revision', 'runtime-revision'].every(name => /^[a-f0-9]{7,64}$/.test(options[name] ?? ''))
    || !/^mb_[a-f0-9]{64}$/i.test(env.MAINBRELLA_API_KEY ?? '')) throw new Error('invalid_arguments');
  const url = new URL(env.MAINBRELLA_API_URL || 'https://api.mainbrella.com');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('invalid_api_url');
  }
  const catalogId = env.MAINBRELLA_CATALOG_ID || 'node';
  if (!/^[a-z0-9_-]{1,64}$/.test(catalogId)) throw new Error('invalid_catalog');
  return { candidate: resolve(options.candidate), output: resolve(options.output), apiOrigin: url.origin, catalogId,
    apiRevision: options['api-revision'], runtimeRevision: options['runtime-revision'],
    loopback: ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), env };
}

export async function readCandidate(directory) {
  const manifestBytes = await readFile(join(directory, 'qualification.json'));
  const manifest = JSON.parse(manifestBytes);
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version) || !localChecks.every(name => manifest.checks?.[name] === true)
    || !Array.isArray(manifest.artifacts) || manifest.artifacts.length !== 3) throw new Error('candidate_unqualified');
  const expected = [`mainbrella-sdk-${manifest.version}.tgz`, `mainbrella-${manifest.version}-py3-none-any.whl`, `mainbrella-${manifest.version}.tar.gz`];
  const archives = [];
  for (const name of expected) {
    const entry = manifest.artifacts.find(artifact => artifact.name === name);
    const bytes = await readFile(join(directory, name));
    if (!entry || entry.bytes !== bytes.length || entry.sha256 !== checksum(bytes)) throw new Error('candidate_checksum_failed');
    archives.push({ name, bytes, sha256: entry.sha256 });
  }
  return { manifest, manifestSha256: checksum(manifestBytes), archives };
}

// Suppress subprocess output: reports contain known checks and recovery identities,
// never credentials, returned command output, server diagnostics or pip/npm logs.
export function runQuiet(command, args, { cwd, env, timeoutMs = 600_000 } = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'ignore' });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('error', () => { clearTimeout(timer); reject(new Error('subprocess_failed')); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? accept() : reject(new Error('subprocess_failed')); });
  });
}

export async function qualifyDeployedArtifacts(options, { run = runQuiet } = {}) {
  const { candidate, output, apiOrigin, catalogId, apiRevision, runtimeRevision, loopback, env } = options;
  // Validate immutable inputs and reserve a new evidence directory before installs/API calls.
  const { manifest, manifestSha256, archives } = await readCandidate(candidate);
  const verifierSources = await Promise.all(workflows.map(async path => ({ path,
    sha256: checksum(await readFile(join(root, path))) })));
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output, { mode: 0o700 });
  const work = await mkdtemp(join(tmpdir(), 'mainbrella-sdk-deployed-'));
  const report = { formatVersion: 1, ok: false, startedAt: new Date().toISOString(), candidateManifestSha256: manifestSha256,
    version: manifest.version, artifacts: archives.map(({ name, sha256, bytes }) => ({ name, sha256, bytes: bytes.length })),
    installedArtifacts: { javascript: archives[0].name, python: archives[1].name },
    verifierSources, apiOrigin, catalogId, size: 'lite', maxStarts: 2, target: loopback ? 'loopback' : 'deployed',
    deploymentRevisions: { source: 'operator_supplied', api: apiRevision, runtime: runtimeRevision },
    sourceRevision: manifest.sourceRevision, sourceDirty: manifest.sourceDirty,
    node: process.version, stage: 'install', results: [] };
  const persist = async () => {
    const path = join(output, 'deployed-qualification.json');
    await writeFile(`${path}.tmp`, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    await rename(`${path}.tmp`, path);
  };
  // Installation tools have no account credential and cannot import from the checkout.
  const installEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith('MAINBRELLA_')
    && !['PYTHONPATH', 'PYTHONHOME'].includes(name)));
  try {
    await persist();
    for (const archive of archives) await writeFile(join(work, archive.name), archive.bytes, { mode: 0o600 });
    const consumer = join(work, 'javascript');
    await mkdir(consumer);
    await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    await run('npm', ['install', '--ignore-scripts', '--offline', '--no-audit', '--no-fund', join(work, archives[0].name)], { cwd: consumer, env: installEnv });
    const installed = JSON.parse(await readFile(join(consumer, 'node_modules/@mainbrella/sdk/package.json')));
    if (installed.version !== manifest.version || installed.name !== '@mainbrella/sdk') throw new Error();
    await copyFile(join(root, workflows[1]), join(consumer, 'sdk-deployed-workflow.mjs'));
    if (checksum(await readFile(join(consumer, 'sdk-deployed-workflow.mjs'))) !== verifierSources[1].sha256) throw new Error();
    const environment = join(work, 'python');
    const pythonCommand = env.PYTHON || 'python3';
    await run(pythonCommand, ['-m', 'venv', environment], { cwd: work, env: installEnv });
    const python = join(environment, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    await run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-index', '--no-deps', join(work, archives[1].name)], { cwd: work, env: installEnv });
    await run(python, ['-I', '-c', `import importlib.metadata; assert importlib.metadata.version('mainbrella') == '${manifest.version}'`], { cwd: work, env: installEnv });
    await copyFile(join(root, workflows[2]), join(work, 'sdk-deployed-workflow.py'));
    if (checksum(await readFile(join(work, 'sdk-deployed-workflow.py'))) !== verifierSources[2].sha256) throw new Error();
    // Both installations complete before the first start. Each workflow checkpoints
    // before every mutation. A failing first language prevents the second from starting.
    for (const language of ['javascript', 'python']) {
      report.stage = language; await persist();
      const resultPath = join(output, `${language}.json`);
      const workflowEnv = { ...installEnv, MAINBRELLA_API_KEY: env.MAINBRELLA_API_KEY,
        MAINBRELLA_API_URL: apiOrigin, MAINBRELLA_CATALOG_ID: catalogId, MAINBRELLA_SDK_REPORT: resultPath };
      let failed = false;
      try {
        await run(language === 'javascript' ? process.execPath : python,
          language === 'javascript' ? ['sdk-deployed-workflow.mjs'] : ['-I', 'sdk-deployed-workflow.py'],
          { cwd: language === 'javascript' ? consumer : work, env: workflowEnv });
      } catch { failed = true; }
      let result;
      try { result = JSON.parse(await readFile(resultPath)); } catch {}
      // Keep incomplete checkpoints for manual reconciliation after interruption.
      if (result) report.results.push(result);
      if (failed || result?.ok !== true || result.cleanup !== 'completed'
        || result.language !== language || !workflowChecks.every(name => result.checks?.[name] === true)) throw new Error();
    }
    const after = await readCandidate(candidate);
    if (after.manifestSha256 !== manifestSha256) throw new Error();
    for (const source of verifierSources) {
      if (checksum(await readFile(join(root, source.path))) !== source.sha256) throw new Error();
    }
    report.ok = true;
  } catch { report.error = `${report.stage}_failed`; }
  finally {
    report.finishedAt = new Date().toISOString(); await persist();
    await rm(work, { recursive: true, force: true });
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseQualificationArgs(process.argv.slice(2));
    const report = await qualifyDeployedArtifacts(options);
    console.log(JSON.stringify({ ok: report.ok, output: options.output, target: report.target }, null, 2));
    process.exitCode = report.ok ? 0 : 1;
  } catch {
    console.error('Use --candidate=DIR --output=NEW_DIR --max-starts=2 --api-revision=SHA --runtime-revision=SHA with MAINBRELLA_API_KEY and a trusted API origin. Candidate checksums must match; existing evidence is never overwritten.');
    process.exitCode = 1;
  }
}

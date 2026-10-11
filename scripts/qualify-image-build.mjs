import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Mainbrella } from '../sdk/javascript/index.js';
import { deploymentPreflight } from './sdk-deployed-workflow.mjs';

const marker = 'mainbrella-image-qualified';
const dockerfile = `FROM mainbrella:base\nRUN mkdir -p /workspace && printf '${marker}' > /workspace/.mainbrella-image-qualification\n`;

export function imageCacheHit(logs) {
  const step = logs.match(/^(#\d+) \[[^\n]+\] RUN mkdir -p \/workspace && printf 'mainbrella-image-qualified'/m)?.[1];
  return Boolean(step && new RegExp(`^${step} CACHED$`, 'm').test(logs));
}

// This verifier is deliberately opt-in. It can publish two images/redeploy the
// runtime and start one billed sandbox. It never enables deployment settings.
export async function qualifyImageBuild(client, { checkpoint, baseImage, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), preflight = deploymentPreflight } = {}) {
  const report = { ok: false, stage: 'preflight', maxBuilds: 2, maxStarts: 1, checks: {}, builds: [], cleanup: 'not_needed' };
  const save = () => checkpoint(structuredClone(report));
  let sandbox;
  async function waitForImage(id) {
    const deadline = now() + 35 * 60_000;
    while (now() < deadline) {
      const { image } = await client.images.get(id);
      if (image.status === 'ready') {
        if (!/^sha256:[a-f0-9]{64}$/.test(image.digest ?? '')) throw new Error();
        return image;
      }
      if (image.status === 'failed') throw new Error();
      await sleep(5_000);
    }
    throw new Error();
  }
  try {
    await preflight(client, { starts: 1 });
    const inventory = await client.images.list();
    if (!inventory.buildsEnabled || baseImage && !inventory.privateRegistriesEnabled
      || inventory.limits.maxBuildsPerMonth - inventory.usage.builds < 2
      || inventory.images.some(image => ['queued', 'building', 'publishing'].includes(image.status))
      || inventory.limits.maxSavedImages - inventory.images.filter(image => image.status === 'ready').length < 2) throw new Error();
    for (let index = 0; index < 2; index++) {
      report.stage = index ? 'cached_build' : 'initial_build';
      const build = { name: `qualification-${randomUUID()}`, state: 'request_pending' };
      report.builds.push(build); report.cleanup = 'pending';
      await save(); // A lost POST is reconciled by this unique name, never retried.
      const { image } = await client.images.create({ name: build.name, dockerfile, baseImage,
        ...(index ? { cacheFrom: report.builds[0].id } : {}) });
      build.id = image.id; build.state = 'admitted'; await save();
      const ready = await waitForImage(image.id);
      build.digest = ready.digest; build.state = 'ready'; await save();
    }
    const secondId = report.builds[1].id;
    report.checks.publishedDigests = true;
    report.stage = 'cache'; await save();
    const { logs } = await client.images.logs(secondId);
    if (!imageCacheHit(logs)) throw new Error();
    report.checks.cacheHit = true;
    report.stage = 'runtime'; report.creationKey = randomUUID(); await save();
    const started = now();
    sandbox = await client.create({ imageId: secondId, size: 'lite', idempotencyKey: report.creationKey });
    report.container = { id: sandbox.id, createdAt: sandbox.createdAt }; await save();
    const result = await sandbox.commands.run('cat /workspace/.mainbrella-image-qualification', { timeoutMs: 30_000 });
    if (result.exitCode !== 0 || result.stdout !== marker || result.timedOut || result.outputTruncated) throw new Error();
    report.timeToFirstCommandMs = now() - started;
    report.checks.customImageRuntime = true;
    report.checks.privateBase = Boolean(baseImage);
  } catch { report.error = `${report.stage}_failed`; }
  finally {
    let containerClean = !report.creationKey;
    if (sandbox) {
      try {
        await sandbox.kill();
        const after = await client.list();
        containerClean = !after.containers.some(item => item.id === sandbox.id && item.createdAt === sandbox.createdAt);
      } catch { containerClean = false; }
    }
    for (const build of report.builds) {
      try {
        if (!build.id) {
          const { images } = await client.images.list();
          const matches = images.filter(image => image.name === build.name);
          if (matches.length === 1) build.id = matches[0].id;
          // No observed match does not prove an ambiguous dispatch cannot arrive.
        }
        if (containerClean && build.id) { await client.images.delete(build.id); build.state = 'deleted'; }
      } catch { /* Active builds/ambiguous replies remain in the recovery report. */ }
    }
    if (report.builds.length) report.cleanup = containerClean && report.builds.every(build => build.state === 'deleted') ? 'completed' : 'reconcile_manually';
    report.ok = !report.error && report.cleanup === 'completed';
    report.stage = 'finished'; await save();
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = {};
    for (const argument of process.argv.slice(2)) {
      const match = /^--(output|max-builds|max-starts|api-revision|runtime-revision)=(.+)$/.exec(argument);
      if (!match || Object.hasOwn(options, match[1])) throw new Error();
      options[match[1]] = match[2];
    }
    if (!options.output || options['max-builds'] !== '2' || options['max-starts'] !== '1'
      || !['api-revision', 'runtime-revision'].every(key => /^[a-f0-9]{7,64}$/.test(options[key] ?? ''))
      || !/^mb_[a-f0-9]{64}$/i.test(process.env.MAINBRELLA_API_KEY ?? '')) throw new Error();
    const apiURL = new URL(process.env.MAINBRELLA_API_URL || 'https://api.mainbrella.com');
    if (apiURL.protocol !== 'https:' || apiURL.username || apiURL.password || apiURL.pathname !== '/' || apiURL.search || apiURL.hash) throw new Error();
    const output = resolve(options.output);
    const baseImage = process.env.MAINBRELLA_QUALIFY_IMAGE_BASE ? JSON.parse(process.env.MAINBRELLA_QUALIFY_IMAGE_BASE) : undefined;
    await mkdir(output, { mode: 0o700 });
    const path = join(output, 'image-qualification.json');
    const client = new Mainbrella({ apiKey: process.env.MAINBRELLA_API_KEY, baseUrl: apiURL.origin });
    const result = await qualifyImageBuild(client, { baseImage, checkpoint: async report => {
      await writeFile(`${path}.tmp`, JSON.stringify({ ...report, apiOrigin: apiURL.origin,
        deploymentRevisions: { source: 'operator_supplied', api: options['api-revision'], runtime: options['runtime-revision'] } }, null, 2) + '\n', { mode: 0o600 });
      await rename(`${path}.tmp`, path);
    } });
    console.log(JSON.stringify({ ok: result.ok, output, cleanup: result.cleanup }));
    process.exitCode = result.ok ? 0 : 1;
  } catch {
    console.error('Image qualification failed. Require --output=NEW_DIR --max-builds=2 --max-starts=1 --api-revision=SHA --runtime-revision=SHA and MAINBRELLA_API_KEY. Retain any recovery report.');
    process.exitCode = 1;
  }
}

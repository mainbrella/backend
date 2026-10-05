export const PROBE_INSTANCES = Object.freeze(['lite', 'standard-1', 'standard-2', 'standard-3', 'standard-4']);
export const PROBE_DEADLINE_MS = 180_000;
const decoder = new TextDecoder();
const text = value => typeof value === 'string' ? value : decoder.decode(value);

async function execute(container, argv, timeoutMs = 60_000) {
  const abort = new AbortController();
  let exited = false, process, timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (!exited) { abort.abort(); try { process?.kill(9); } catch {} }
      reject(new Error('probe_timeout'));
    }, timeoutMs);
  });
  try {
    const starting = container.exec(argv, { signal: abort.signal });
    void starting.then(value => { if (abort.signal.aborted) { try { value.kill(9); } catch {} } }).catch(() => {});
    process = await Promise.race([starting, expired]);
    void process.exitCode.then(() => { exited = true; }, () => {});
    const result = await Promise.race([process.output(), expired]);
    if (result.exitCode !== 0) throw new Error('probe_workload_failed');
    return text(result.stdout);
  } finally {
    clearTimeout(timer);
    if (!exited) { abort.abort(); try { process?.kill(9); } catch {} }
  }
}

// Call only on an isolated, disposable DO with the durable_object policy. No
// production account bindings, user input commands or Mainbrella quota changes.
export async function probeRuntime(ctx, { instance = 'lite', snapshot = true, workload = 'files' } = {}) {
  if (!PROBE_INSTANCES.includes(instance) || typeof snapshot !== 'boolean' || !['files', 'typescript'].includes(workload)) throw new Error('invalid_probe_options');
  if (ctx.container.running || await ctx.storage.get('probeStarted')) throw new Error('probe_already_used');
  const image = ctx.container.images.terminal;
  if (!image) throw new Error('probe_image_unavailable');
  await ctx.storage.put('probeStarted', true);
  await ctx.storage.setAlarm(Date.now() + PROBE_DEADLINE_MS);
  const marker = crypto.randomUUID();
  const result = { ok: false, instance, imageDigest: image, workload, startedAt: new Date().toISOString(), timings: {}, cleanup: 'pending' };
  let phase = 'start';
  try {
    const beforeStart = performance.now();
    ctx.container.start({ image, instance, entrypoint: ['sleep', 'infinity'], enableInternet: false });
    await ctx.container.setInactivityTimeout(PROBE_DEADLINE_MS);
    await execute(ctx.container, ['node', '--version']);
    result.timings.startMs = performance.now() - beforeStart;
    phase = 'workload';
    const source = `const fs=require('node:fs'),crypto=require('node:crypto'),cp=require('node:child_process');
      fs.mkdirSync('/workspace',{recursive:true});
      fs.writeFileSync('/workspace/probe.bin',crypto.randomBytes(2*1024*1024));
      fs.writeFileSync('/workspace/probe-marker',${JSON.stringify(marker)});
      ${workload === 'typescript' ? "for(let i=0;i<200;i++)fs.writeFileSync('/workspace/module'+i+'.ts','export const value: number = '+i+';'); cp.execFileSync('tsc',['--noEmit',...fs.readdirSync('/workspace').filter(f=>f.endsWith('.ts')).map(f=>'/workspace/'+f)],{timeout:45000});" : ''}
      console.log(crypto.createHash('sha256').update(fs.readFileSync('/workspace/probe.bin')).digest('hex'));`;
    const beforeWork = performance.now();
    const digest = (await execute(ctx.container, ['node', '-e', source])).trim();
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('probe_result_invalid');
    result.timings.workloadMs = performance.now() - beforeWork;
    result.fileSha256 = digest;
    if (snapshot) {
      phase = 'snapshot';
      const beforeSnapshot = performance.now();
      const handle = await ctx.container.snapshotContainer({ name: `probe-${marker}` });
      if (!handle?.id) throw new Error('snapshot_unavailable');
      await ctx.storage.put('probeSnapshot', { handle, imageDigest: image, fileSha256: digest });
      result.timings.snapshotMs = performance.now() - beforeSnapshot;
      result.snapshotBytes = handle.size;
      await ctx.container.destroy();
      phase = 'restore';
      const beforeRestore = performance.now();
      // Missing or rejected snapshots never fall back to an empty image.
      ctx.container.start({ containerSnapshot: { id: handle.id }, instance, entrypoint: ['sleep', 'infinity'], enableInternet: false });
      const verify = `const fs=require('node:fs'),crypto=require('node:crypto');
        if(fs.readFileSync('/workspace/probe-marker','utf8')!==${JSON.stringify(marker)})process.exit(2);
        if(crypto.createHash('sha256').update(fs.readFileSync('/workspace/probe.bin')).digest('hex')!==${JSON.stringify(digest)})process.exit(3);
        console.log('verified');`;
      if ((await execute(ctx.container, ['node', '-e', verify])).trim() !== 'verified') throw new Error('restore_content_mismatch');
      result.timings.restoreMs = performance.now() - beforeRestore;
      result.filesystemRestored = true;
    }
    result.ok = true;
  } catch {
    result.error = `${phase}_failed`;
  } finally {
    try {
      if (ctx.container.running) await ctx.container.destroy();
      await ctx.storage.deleteAlarm();
      result.cleanup = 'completed';
    } catch { result.cleanup = 'failed'; result.ok = false; }
    result.finishedAt = new Date().toISOString();
    await ctx.storage.put('probeResult', result);
  }
  return result;
}

import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { Mainbrella } from '../sdk/javascript/index.js';
import { MACHINE_SIZES, PLAN_DETAILS } from '../containers/plan-policy.js';
import { estimateResourceCost } from './estimate-resource-cost.mjs';
import { workloadDefinitions, diagnosticCommand } from './benchmark-workloads.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const check = (value, code) => { if (!value) throw new Error(code); };
const same = (a,b) => a.id === b.id && a.createdAt === b.createdAt;
export const providerRates = { cpuPerVcpuSecond: 0.000020, memoryPerGiBSecond: 0.0000025, diskPerGBSecond: 0.00000007 };
export function sizeEconomics(rates = providerRates) {
  const sizes = MACHINE_SIZES.map(size => ({ ...size,
    idleHourlyUSD: estimateResourceCost({ cpuSeconds: 0, memoryMiB: size.memoryMiB, diskGB: size.diskGB, runningSeconds: 3600, rates }).resourceCost.total,
    saturatedHourlyUSD: estimateResourceCost({ cpuSeconds: 3600 * size.cpuVcpu, memoryMiB: size.memoryMiB, diskGB: size.diskGB, runningSeconds: 3600, rates }).resourceCost.total,
  }));
  return { rates, priceSource: 'https://developers.cloudflare.com/containers/platform/pricing/', checkedAt: '2026-10-06', sizes,
    plans: Object.entries(PLAN_DETAILS).map(([id, plan]) => {
      const worst = sizes.reduce((a,b) => a.saturatedHourlyUSD / a.computeUnits > b.saturatedHourlyUSD / b.computeUnits ? a : b);
      const grossComputeUSD = plan.limits.maxComputeUnitHours * worst.saturatedHourlyUSD / worst.computeUnits;
      return { id, priceUSD: plan.price, allowanceComputeUnitHours: plan.limits.maxComputeUnitHours, worstSize: worst.id,
        saturatedAllowanceComputeUSD: grossComputeUSD, remainingBeforeOtherCostsUSD: plan.price - grossComputeUSD };
    }),
    exclusions: ['included provider allowances', 'egress (placement/bytes unmeasured)', 'Workers', 'Durable Objects', 'D1', 'logs', 'builds', 'registry', 'snapshots', 'support'],
    totalEconomicsQualified: false };
}

export async function benchmarkSizes(client, { maxStarts = 17, checkpoint = async () => {}, runPhase, previous, matrix = MACHINE_SIZES.flatMap(size => Object.keys(workloadDefinitions).map(catalogId => ({size:size.id,catalogId}))), concurrencySamples = 2 } = {}) {
  check(Number.isInteger(maxStarts) && maxStarts >= matrix.length + concurrencySamples && maxStarts <= 17, 'invalid_start_budget');
  check(concurrencySamples === 0 || concurrencySamples === 2, 'invalid_concurrency');
  check(matrix.every(item => MACHINE_SIZES.some(size => size.id === item.size) && workloadDefinitions[item.catalogId]), 'invalid_matrix');
  const capabilities = await client.capabilities(), before = await client.list();
  check(capabilities.execution?.background && capabilities.execution?.reconnect && capabilities.files?.write, 'capability_missing');
  if(previous)check(previous.maxStarts===maxStarts && previous.cleanup==='completed' && previous.startsRequested===previous.generations?.length
    && previous.generations.length<matrix.length && previous.generations.every((g,i)=>g.cleanup==='completed'&&g.size===matrix[i].size&&g.catalogId===matrix[i].catalogId)
    && before.usage.starts===previous.before.starts+previous.startsRequested,'invalid_resume_evidence');
  check(before.active && before.limits.maxStartsPerMonth - before.usage.starts >= maxStarts-(previous?.startsRequested??0), 'insufficient_start_budget');
  check(before.containers.length === 0, 'preexisting_workloads');
  check(matrix.every(item => before.imageCatalog.some(image => image.id === item.catalogId)), 'catalog_missing');
  check(before.limits.maxContainers >= Math.max(1,concurrencySamples) && before.limits.maxConcurrentComputeUnits >= Math.max(28,concurrencySamples*6), 'insufficient_capacity');
  const report = { formatVersion: 1, startedAt: new Date().toISOString(), ok: false, releaseQualified: false, maxStarts, startsRequested: previous?.startsRequested??0,
    apiOrigin: client.baseUrl, apiVersion: capabilities.apiVersion, before: previous?.before??{ starts: before.usage.starts, computeUnitHours: before.usage.computeUnitHours },
    methodology: 'One fresh generation per language/size; two simultaneous Small Node generations. Empty workload caches. Public API startup includes admission/readiness/polling. Provider image/cache placement is unknown; no cold-cache claim. Single samples do not establish p95. Ten-minute wall deadline per generation. Failures retained. Resource costs are upper bounds assuming fully active allocated CPU, excluding other services.',
    generations: structuredClone(previous?.generations??[]), economics: sizeEconomics(), cleanup: 'not_needed' };
  const save = () => checkpoint(structuredClone(report));
  runPhase ??= async (sandbox, phase, remainingMs, sample) => {
    const started = performance.now();
    const executionKey = randomUUID(); sample.pendingExecutionKey = executionKey; await save();
    const execution = await sandbox.commands.start(['bash', '-lc', `set -eu\n${phase.command}`], { timeoutMs: Math.min(240_000,remainingMs), idempotencyKey: executionKey });
    sample.pendingExecutionId = execution.id; await save();
    const result = await execution.wait({ timeoutMs: Math.min(250_000,remainingMs), pollIntervalMs: 1500 });
    return { name: phase.name, elapsedMs: performance.now()-started, status: result.status, exitCode: result.exitCode,
      timedOut: result.timedOut, outputTruncated: result.outputTruncated, stdout: result.stdout, stderr: result.stderr };
  };
  const generation = async (item, exercise = true) => {
    const sample = { ...item, creationKey: randomUUID(), cleanup: 'reconcile_manually', phases: [], startedAt: new Date().toISOString() };
    report.generations.push(sample); report.startsRequested++; report.cleanup='pending'; await save();
    const started = performance.now(), deadline=Date.now()+600_000;
    let sandbox, deadlineTimer, cleanupPromise;
    try {
      sandbox = await client.create({ ...item, idempotencyKey:sample.creationKey, waitTimeoutMs:90_000 });
      sample.container = { id:sandbox.id, createdAt:sandbox.createdAt, imageDigest:sandbox.imageDigest, instance:sandbox.instance };
      sample.startupMs=performance.now()-started; sample.cleanup='pending'; await save();
      check(sandbox.instance===MACHINE_SIZES.find(size=>size.id===item.size).instance && sandbox.imageDigest, 'resource_unconfirmed');
      deadlineTimer=setTimeout(()=>{sample.deadlineExceeded=true; cleanupPromise=sandbox.kill().catch(()=>{sample.cleanup='failed';});},Math.max(1,deadline-Date.now()));
      sample.diagnosticsBefore=await sandbox.commands.run(diagnosticCommand,{timeoutMs:15_000});
      for (const phase of exercise ? workloadDefinitions[item.catalogId] : [{name:'concurrent-build',command:workloadDefinitions.node[0].command+'\n'+workloadDefinitions.node[1].command}]) {
        if (Date.now()>=deadline) break;
        const result=await runPhase(sandbox,phase,Math.max(1,deadline-Date.now()),sample);
        sample.phases.push(result); delete sample.pendingExecutionKey; delete sample.pendingExecutionId; await save();
        if(result.status!=='succeeded') {sample.error=`${phase.name}_failed`; break;}
      }
      if (!sample.deadlineExceeded) sample.diagnosticsAfter=await sandbox.commands.run(diagnosticCommand,{timeoutMs:15_000});
    } catch(error) {sample.error=typeof error.code==='string'?error.code:'sample_failed';}
    finally {
      clearTimeout(deadlineTimer);
      if(sandbox) {
        try {await cleanupPromise; await sandbox.kill(); sample.cleanup='completed';} catch {sample.cleanup='failed';}
      }
      sample.elapsedMs=performance.now()-started;
      const size=MACHINE_SIZES.find(size=>size.id===item.size);
      sample.resourceCostUpperBound=estimateResourceCost({cpuSeconds:sample.elapsedMs/1000*size.cpuVcpu,memoryMiB:size.memoryMiB,diskGB:size.diskGB,runningSeconds:sample.elapsedMs/1000,rates:providerRates});
      sample.ok=!sample.error && !sample.deadlineExceeded && sample.cleanup==='completed'; await save();
    }
    return sample;
  };
  for(const item of matrix.slice(previous?.generations.length??0)) { const result=await generation(item); if(result.cleanup!=='completed') break; }
  if(concurrencySamples && report.generations.length===matrix.length && report.generations.every(g=>g.cleanup==='completed')) {
    await Promise.all(Array.from({length:concurrencySamples},()=>generation({catalogId:'node',size:'small',concurrent:true},false)));
  }
  const after=await client.list(); report.after={starts:after.usage.starts,computeUnitHours:after.usage.computeUnitHours,containers:after.containers.map(({id,createdAt})=>({id,createdAt}))};
  report.cleanup=report.generations.every(g=>g.cleanup==='completed') && !after.containers.length?'completed':'failed';
  report.summary={attempted:report.generations.length,succeeded:report.generations.filter(g=>g.ok).length,failed:report.generations.filter(g=>!g.ok).length};
  report.ok=report.cleanup==='completed' && report.summary.failed===0 && report.generations.length===matrix.length+concurrencySamples && after.usage.starts-report.before.starts===report.startsRequested;
  report.finishedAt=new Date().toISOString(); await save(); return report;
}

if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args={}; for(const arg of process.argv.slice(2)) {const match=/^--(output|max-starts|resume)=(.+)$/.exec(arg);check(match&&!Object.hasOwn(args,match[1]),'invalid_arguments');args[match[1]]=match[2];}
    check(args.output && Number(args['max-starts'])===17,'explicit_budget_required');
    const output=resolve(args.output);await mkdir(output,{mode:0o700});
    const env={...parseEnv(await readFile(join(root,'.env'),'utf8')),...process.env};
    const client=new Mainbrella({apiKey:env.MAINBRELLA_API_KEY,baseUrl:env.MAINBRELLA_API_URL});
    const sources=await Promise.all(['scripts/benchmark-sizes.mjs','scripts/benchmark-workloads.mjs','containers/plan-policy.js','sdk/javascript/index.js'].map(async path=>({path,sha256:createHash('sha256').update(await readFile(join(root,path))).digest('hex')})));
    const revision=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
    const previousBytes=args.resume?await readFile(resolve(args.resume)):null,previous=previousBytes?JSON.parse(previousBytes):undefined;
    const previousEvidence=previousBytes?{path:resolve(args.resume),sha256:createHash('sha256').update(previousBytes).digest('hex')}:null;
    const checkpoint=async report=>{const path=join(output,'benchmark.json');await writeFile(path+'.tmp',JSON.stringify({...report,revision,sources,previousEvidence},null,2)+'\n',{mode:0o600});await rename(path+'.tmp',path);};
    // Concurrent samples serialize report writes so atomic renames cannot race.
    let tail=Promise.resolve(); const save=report=>tail=tail.then(()=>checkpoint(report));
    const report=await benchmarkSizes(client,{maxStarts:17,checkpoint:save,previous});
    console.log(JSON.stringify({output,summary:report.summary,cleanup:report.cleanup,ok:report.ok}));if(!report.ok)process.exitCode=1;
  }catch(error){console.error(`Benchmark stopped: ${/^[a-z_]+$/.test(error.message)?error.message:'check_private_report'}. Inspect recovery keys before rerunning.`);process.exitCode=1;}
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkSizes, sizeEconomics } from './benchmark-sizes.mjs';
import { MACHINE_SIZES } from '../containers/plan-policy.js';

function fixture({failedPhase=false,failedCleanup=false}={}) {
  const starts=[], stopped=[]; let live=0,peak=0;
  const client={baseUrl:'http://localhost:8787',async capabilities(){return {apiVersion:'test',execution:{background:true,reconnect:true},files:{write:true}};},
    async list(){return {active:true,imageCatalog:['node','python','rust'].map(id=>({id})),containers:[],limits:{maxStartsPerMonth:100,maxContainers:5,maxConcurrentComputeUnits:28},usage:{starts:starts.length,computeUnitHours:0}};},
    async create(options){starts.push(options);live++;peak=Math.max(peak,live);return {id:'small',createdAt:new Date(starts.length).toISOString(),imageDigest:'digest',instance:MACHINE_SIZES.find(s=>s.id===options.size).instance,
      commands:{async run(){return {exitCode:0,stdout:'diagnostic'};}},async kill(){stopped.push(options.idempotencyKey);live--;if(failedCleanup)throw new Error();}};}};
  const runPhase=async(_sandbox,phase)=>{await new Promise(done=>setTimeout(done,1));return {name:phase.name,status:failedPhase?'failed':'succeeded',exitCode:failedPhase?1:0};};
  return {client,runPhase,starts,stopped,get peak(){return peak;}};
}
test('five-size matrix records failures and bounded simultaneous samples with recovery evidence preceding create',async()=>{
  const f=fixture(),checkpoints=[];
  const report=await benchmarkSizes(f.client,{runPhase:f.runPhase,checkpoint:async report=>{checkpoints.push(structuredClone(report));}});
  assert.equal(report.ok,true);assert.equal(f.starts.length,17);assert.equal(f.peak,2);assert.equal(report.cleanup,'completed');
  assert.equal(new Set(f.starts.map(s=>s.idempotencyKey)).size,17);
  assert.equal(report.generations.filter(g=>g.concurrent).length,2);
  for(const start of f.starts)assert.ok(checkpoints.some(c=>c.generations.some(g=>g.creationKey===start.idempotencyKey && !g.container)));
  assert.equal(report.releaseQualified,false);
});
test('cleanup failure stops further charged samples; workload failures stay visible',async()=>{
  const f=fixture({failedCleanup:true});
  const report=await benchmarkSizes(f.client,{runPhase:f.runPhase});assert.equal(f.starts.length,1);assert.equal(report.ok,false);assert.equal(report.cleanup,'failed');
  const failure=fixture({failedPhase:true});const failed=await benchmarkSizes(failure.client,{runPhase:failure.runPhase});
  assert.equal(failed.ok,false);assert.equal(failed.summary.failed,17);assert.equal(failed.cleanup,'completed');
  await assert.rejects(benchmarkSizes(f.client,{maxStarts:16}),/invalid_start_budget/);
});
test('saturated plan allowance cost exposes remaining margins and excludes unmeasured services',()=>{
  const report=sizeEconomics();assert.equal(report.sizes.length,5);
  assert.ok(report.sizes.every(s=>s.saturatedHourlyUSD>s.idleHourlyUSD));
  assert.equal(report.plans[0].worstSize,'xl');assert.ok(report.plans[0].remainingBeforeOtherCostsUSD>0);
  assert.equal(report.totalEconomicsQualified,false);assert.ok(report.exclusions.includes('snapshots'));
});

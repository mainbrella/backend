import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyWorkspaces} from './verify-workspaces.mjs';
function fixture({lostCreation=false,staleDelete=false}={}){
  let starts=0,live=[],workspace,deleted=false,archived=false;const snapshots=[];
  const client={async capabilities(){return {persistence:{snapshots:true,exports:true}};},async list(){return {active:true,containers:live,usage:{starts},limits:{maxStartsPerMonth:100}};},
    workspaces:{async update(_id,body){archived=body.archived;},async delete(){deleted=true;}},
    async request(path,options={}){
      if(path==='/containers'){
        if(options.body.workspaceId){if(deleted)throw {status:404};if(archived)throw {status:409};}
        starts++;if(lostCreation)throw {code:'transport_unavailable'};
        const container={id:'small',createdAt:new Date(starts).toISOString(),status:'running',...(options.body.workspaceId?{workspaceId:options.body.workspaceId}:{})};live=[container];return {containers:live,creation:{containerId:'small',createdAt:container.createdAt,status:'running'}};
      }
      if(path==='/workspaces'){workspace??={id:'d688d42a-25ef-4c13-9b28-21a0fde6e163',status:'ready',stopCompleted:true};live=[];return workspace;}
      return {status:'interrupted'};
    },connect(container){const number=starts;return {...container,path:p=>p,files:{async write(){},async read(){if(number===1)throw {status:409};return new Uint8Array([0,255,128,10]);}},commands:{async run(){return {exitCode:0};},async start(){return {id:'process'};}},async exportWorkspace(){return new Uint8Array([1]);},async kill(){if(staleDelete&&number===1&&starts===2)throw {status:409};live=[];}};}};
  const secondary={workspaces:{async get(){throw {status:404};}}};return {client,secondary,snapshots};
}
test('persistence qualifier verifies two starts, ownership and cleanup with durable intents',async()=>{
  const f=fixture(),report=await verifyWorkspaces(f.client,f.secondary,{checkpoint:async report=>f.snapshots.push(report),verifyArchive:bytes=>assert.deepEqual(bytes,new Uint8Array([1]))});
  assert.equal(report.ok,true);assert.equal(report.startsRequested,2);assert.equal(report.cleanup,'completed');assert.equal(report.checks.filesystem,true);
  assert.ok(f.snapshots.some(s=>s.generations[0]?.key&&!s.generations[0].container));assert.ok(f.snapshots.some(s=>s.saveKey&&!s.workspaceId));
});
test('ambiguous creation stops before another paid admission and retains recovery key',async()=>{
  const f=fixture({lostCreation:true}),report=await verifyWorkspaces(f.client,f.secondary);assert.equal(report.ok,false);assert.equal(report.startsRequested,1);assert.equal(report.cleanup,'reconcile_manually');assert.ok(report.generations[0].key);
});
test('disabled deployment rejects qualification before spending',async()=>{
  const f=fixture();f.client.capabilities=async()=>({});await assert.rejects(verifyWorkspaces(f.client,f.secondary),/persistence_unavailable/);assert.equal((await f.client.list()).usage.starts,0);
});
test('replaced source DELETE rejection is accepted only after its exact generation is absent',async()=>{
  const f=fixture({staleDelete:true}),report=await verifyWorkspaces(f.client,f.secondary);
  assert.equal(report.ok,true);assert.equal(report.cleanup,'completed');assert.equal(report.afterStarts,2);
});
test('DELETE rejection cannot hide a still-running generation',async()=>{
  const f=fixture(),connect=f.client.connect;
  f.client.connect=container=>({...connect(container),async kill(){throw {status:409};}});
  const report=await verifyWorkspaces(f.client,f.secondary);
  assert.equal(report.ok,false);assert.equal(report.cleanupError,true);assert.equal(report.cleanup,'reconcile_manually');assert.equal(report.remaining.length,1);
});

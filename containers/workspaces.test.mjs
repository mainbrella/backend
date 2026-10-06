import test from 'node:test';
import assert from 'node:assert/strict';
import { ContainerAccountController, machineName } from './container-account-core.js';
import { UserContainerController } from './user-container-core.js';
import { entitlementHeaders } from './plan-policy.js';
import { WORKSPACE_POLICY, WORKSPACE_CAPTURE_RETENTION_MS } from './workspace-contract.js';

class Storage {
  values=new Map();alarm=null;
  async transaction(callback){return callback(this);}
  async get(k){return structuredClone(this.values.get(k));}
  async put(k,v){if(typeof k==='object')for(const [key,value]of Object.entries(k))this.values.set(key,structuredClone(value));else this.values.set(k,structuredClone(v));}
  async delete(k){if(Array.isArray(k))return k.reduce((n,key)=>n+Number(this.values.delete(key)),0);return this.values.delete(k);}
  async list({prefix,limit=1000,startAfter}){return new Map([...this.values].sort(([a],[b])=>a.localeCompare(b)).filter(([k])=>k.startsWith(prefix)&&(!startAfter||k>startAfter)).slice(0,limit));}
  async setAlarm(at){this.alarm=at;}async deleteAlarm(){this.alarm=null;}
}
function fixture(initialPlan='builder'){
  let plan=initialPlan;
  let now=Date.UTC(2026,9,6),paid=true;const snapshots=new Map(),machines=new Map(),accounts=new Map();
  const machineFor=(user,id)=>{
    const name=machineName(user,id);if(!machines.has(name)){
      const runtime={running:false,images:{terminal:'registry/image@sha256:'+'a'.repeat(64)},starts:[],captures:0,files:{},
        start(options){this.starts.push(options);if(this.restoreFails&&options.containerSnapshot)throw new Error('provider-private-details');this.running=true;this.files=options.containerSnapshot?structuredClone(snapshots.get(options.containerSnapshot.id)):{};},
        async snapshotContainer(){this.captures++;if(this.captureFails)throw new Error();if(this.gate)await this.gate;const handle={id:crypto.randomUUID(),size:2048};snapshots.set(handle.id,structuredClone(this.files));return handle;},
        async setInactivityTimeout(){},async destroy(){this.running=false;},async exec(){return {output:async()=>({exitCode:0})};}};
      const ctx={storage:new Storage(),container:runtime},controller=new UserContainerController(ctx,()=>now);
      machines.set(name,{ctx,controller,runtime,fetch:req=>controller.fetch(req)});
    }return machines.get(name);
  };
  const accountFor=user=>{if(!accounts.has(user))accounts.set(user,new ContainerAccountController({storage:new Storage()},machineFor,()=>now));return accounts.get(user);};
  const call=async(path,method='GET',body,headers={},user='owner')=>{
    const response=await accountFor(user).fetch(new Request('https://internal'+path,{method,headers:{'x-mainbrella-user':user,
      ...entitlementHeaders({active:paid,plan:paid?plan:null,validUntil:paid?now+90*86400_000:null,checkedAt:now}),...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})}));
    return {status:response.status,data:await response.json()};
  };
  const start=async(body={},key=crypto.randomUUID(),user='owner')=>call('/containers','POST',body,{'Idempotency-Key':key},user);
  const save=async(source,options={},key=crypto.randomUUID(),user='owner')=>call('/workspaces','POST',{id:source.id,createdAt:source.createdAt,name:'My workspace',...options},{'Idempotency-Key':key},user);
  return {call,start,save,machineFor,accountFor,accounts,now:()=>now,setTime:value=>{now=value;},setPaid:value=>{paid=value;},setPlan:value=>{plan=value;}};
}

test('save/stop/restore survives controller restart, restores bytes and issues a fresh fenced generation',async()=>{
  const f=fixture(),created=await f.start(),source=created.data.containers[0],runtime=f.machineFor('owner',source.id).runtime;
  runtime.files={'binary':new Uint8Array([0,255,128]),'nested/marker':'preserved'};
  const saved=await f.save(source,{stop:true},'save-key');assert.equal(saved.status,201);assert.equal(saved.data.stopCompleted,true);
  assert.equal(runtime.running,false);assert.ok(!JSON.stringify(saved.data).includes('handle'));
  const account=f.accountFor('owner');f.accounts.set('owner',new ContainerAccountController(account.ctx,f.machineFor,f.now));
  assert.equal((await f.save(source,{stop:true},'save-key')).status,200);assert.equal(runtime.captures,1);
  const restored=await f.start({workspaceId:saved.data.id},'restore-key');assert.equal(restored.status,200);
  const current=restored.data.containers[0];assert.notEqual(current.createdAt,source.createdAt);assert.equal(current.workspaceId,saved.data.id);
  assert.deepEqual(runtime.files,{'binary':new Uint8Array([0,255,128]),'nested/marker':'preserved'});
  assert.equal(runtime.starts.at(-1).image,undefined);assert.ok(runtime.starts.at(-1).containerSnapshot.id);
  assert.equal((await f.start({workspaceId:saved.data.id},'restore-key')).data.creation.id,restored.data.creation.id);
  assert.equal(restored.data.usage.starts,2);
  const stale=await f.call('/containers?id=small&createdAt='+encodeURIComponent(source.createdAt),'DELETE');assert.equal(stale.status,409);assert.equal(runtime.running,true);
});
test('ownership, archived policy, resource/network selection, image compatibility and expiry fail before admission',async()=>{
  const f=fixture(),source=(await f.start()).data.containers[0],saved=(await f.save(source,{stop:true})).data;
  assert.equal((await f.call('/workspaces?workspaceId='+saved.id,'GET',undefined,{},'other')).status,404);
  assert.equal((await f.start({workspaceId:saved.id},'foreign','other')).status,404);
  await f.call('/workspaces?workspaceId='+saved.id,'PATCH',{archived:true});assert.equal((await f.start({workspaceId:saved.id})).data.error,'workspace_not_ready');
  await f.call('/workspaces?workspaceId='+saved.id,'PATCH',{archived:false});
  assert.equal((await f.start({workspaceId:saved.id,size:'xl'})).data.error,'workspace_policy_conflict');
  assert.equal((await f.start({workspaceId:saved.id,internet:false})).data.error,'workspace_policy_conflict');
  const runtime=f.machineFor('owner','small').runtime,original=runtime.images.terminal;runtime.images.terminal='changed-image';
  assert.equal((await f.start({workspaceId:saved.id})).data.error,'workspace_image_incompatible');runtime.images.terminal=original;
  f.setTime(saved.expiresAt);assert.equal((await f.start({workspaceId:saved.id})).status,410);
  assert.equal((await f.call('/workspaces?workspaceId='+saved.id)).data.status,'expired');
  assert.equal((await f.call('/containers')).data.usage.starts,1);
  assert.equal((await f.accountFor('owner').workspaces.index()).records[0].handle,undefined);
});
test('quotas include archives, deletion releases quota and remains available during billing loss',async()=>{
  const f=fixture(),source=(await f.start()).data.containers[0];
  const saved=[];for(let i=0;i<3;i++)saved.push((await f.save(source)).data);
  await f.call('/workspaces?workspaceId='+saved[0].id,'PATCH',{archived:true});
  assert.equal((await f.save(source)).status,429);assert.equal(f.machineFor('owner','small').runtime.captures,3);
  f.setPaid(false);assert.equal((await f.call('/workspaces')).data.workspaces.length,3);
  assert.equal((await f.call('/workspaces?workspaceId='+saved[0].id,'DELETE')).status,200);
  assert.equal((await f.call('/workspaces?workspaceId='+saved[0].id,'DELETE')).status,200);
  f.setPaid(true);assert.equal((await f.save(source)).status,201);
});
test('lost snapshot response reconciles receipt without recapture, and changed idempotency inputs conflict',async()=>{
  const f=fixture(),source=(await f.start()).data.containers[0],machine=f.machineFor('owner','small'),original=machine.fetch;
  let lost=true;machine.fetch=async req=>{const response=await original(req);if(lost&&new URL(req.url).pathname==='/workspaces/snapshot-v1'){lost=false;throw new Error('response_lost');}return response;};
  assert.equal((await f.save(source,{},'recovery')).status,503);assert.equal(machine.runtime.captures,1);
  assert.equal((await f.save(source,{},'recovery')).status,201);assert.equal(machine.runtime.captures,1);
  assert.deepEqual((await f.call('/workspaces')).data.usage,{saved:1,reservedBytes:2_000_000_000,savesThisMonth:1,captureBytesThisMonth:2_000_000_000,retainedCaptureBytes:2_000_000_000});
  assert.equal((await f.save(source,{name:'different'},'recovery')).status,409);
});
test('provider restore rejection never starts an empty image; uncertain capture cannot be repeated',async()=>{
  const f=fixture(),source=(await f.start()).data.containers[0],saved=(await f.save(source,{stop:true})).data,runtime=f.machineFor('owner','small').runtime;
  runtime.restoreFails=true;const result=await f.start({workspaceId:saved.id});assert.equal(result.data.error,'workspace_restore_failed');
  assert.equal(runtime.starts.length,2);assert.equal(runtime.starts[1].image,undefined);assert.equal(runtime.running,false);
  runtime.restoreFails=false;const next=(await f.start()).data.containers.find(c=>c.status==='running');const nextRuntime=f.machineFor('owner',next.id).runtime;nextRuntime.captureFails=true;
  assert.equal((await f.save(next,{},'uncertain')).status,503);assert.equal((await f.save(next,{},'uncertain')).status,503);
  assert.equal(nextRuntime.captures,1);
  assert.equal((await f.call('/workspaces')).data.usage.savesThisMonth,2);
});

for(const plan of ['builder','pro','scale']){
  test(`${plan}: live count and monthly saves are enforced before provider capture`,async()=>{
    const f=fixture(plan),policy=WORKSPACE_POLICY[plan],saved=[];
    let source=(await f.start()).data.containers[0];
    for(let i=0;i<policy.maxSaved;i++){
      const response=await f.save(source);assert.equal(response.status,201);saved.push(response.data.id);
    }
    await f.call('/workspaces?workspaceId='+saved[0],'PATCH',{archived:true});
    assert.equal((await f.save(source)).data.error,'workspace_quota_exceeded');
    for(const id of saved)await f.call('/workspaces?workspaceId='+id,'DELETE');
    for(let i=policy.maxSaved;i<policy.maxSavesPerMonth;i++){
      // The runtime separately caps one day's recovery receipts at 100.
      if(i%100===0){f.setTime(f.now()+86400_000);source=(await f.start()).data.containers[0];}
      const response=await f.save(source);assert.equal(response.status,201);
      await f.call('/workspaces?workspaceId='+response.data.id,'DELETE');
    }
    const rejected=await f.save(source);assert.equal(rejected.status,429);assert.equal(rejected.data.error,'workspace_save_limit');
    assert.equal(f.machineFor('owner',source.id).runtime.captures,policy.maxSavesPerMonth);
    assert.equal((await f.call('/workspaces')).data.usage.savesThisMonth,policy.maxSavesPerMonth);
  });
  test(`${plan}: full-disk capture budgets survive deletion, receipt pruning, restart and month rollover`,async()=>{
    const f=fixture(plan),size=plan==='builder'?'small':'xl',disk=plan==='builder'?8_000_000_000:20_000_000_000;
    const source=(await f.start({size})).data.containers[0],limit=WORKSPACE_POLICY[plan].maxCaptureBytesPerMonth;
    const count=Math.floor(limit/disk),startedAt=f.now();
    for(let i=0;i<count;i++){
      const saved=await f.save(source);assert.equal(saved.status,201);
      await f.call('/workspaces?workspaceId='+saved.data.id,'DELETE');
    }
    let response=await f.save(source);assert.equal(response.status,429);assert.equal(response.data.error,'workspace_capture_budget_exceeded');
    assert.equal(f.machineFor('owner',source.id).runtime.captures,count);
    f.setTime(Date.UTC(2026,10,1));
    const account=f.accountFor('owner');f.accounts.set('owner',new ContainerAccountController(account.ctx,f.machineFor,f.now));
    const usage=(await f.call('/workspaces')).data.usage;
    assert.equal(usage.saved,0);assert.equal(usage.savesThisMonth,0);assert.equal(usage.captureBytesThisMonth,0);assert.equal(usage.retainedCaptureBytes,count*disk);
    assert.equal((await f.accountFor('owner').workspaces.index()).records.length,0);
    const next=(await f.start({size})).data.containers[0];
    response=await f.save(next);assert.equal(response.status,429);assert.equal(response.data.error,'workspace_retained_budget_exceeded');
    f.setTime(startedAt+WORKSPACE_CAPTURE_RETENTION_MS);
    assert.equal((await f.call('/workspaces')).data.usage.retainedCaptureBytes,0);
    const later=(await f.start({size})).data.containers[0];assert.equal((await f.save(later)).status,201);
  });
}

test('live disk quota rejects a larger machine before capture on each plan',async()=>{
  for(const [plan,size,disk] of [['builder','small',8e9],['pro','large',16e9],['scale','xl',20e9]]){
    const f=fixture(plan),source=(await f.start({size})).data.containers[0],policy=WORKSPACE_POLICY[plan];
    for(let i=0;i<policy.maxReservedBytes/disk;i++)assert.equal((await f.save(source)).status,201);
    const captures=f.machineFor('owner',source.id).runtime.captures;
    assert.equal((await f.save(source)).data.error,'workspace_quota_exceeded');
    assert.equal(f.machineFor('owner',source.id).runtime.captures,captures);
  }
  const f=fixture(),source=(await f.start({size:'xl'})).data.containers[0];
  assert.equal((await f.save(source)).data.error,'workspace_quota_exceeded');assert.equal(f.machineFor('owner',source.id).runtime.captures,0);
});

test('concurrent saves cannot overspend the last capture reservation',async()=>{
  const f=fixture(),source=(await f.start({size:'small'})).data.containers[0];
  const saved=await f.save(source);await f.call('/workspaces?workspaceId='+saved.data.id,'DELETE');
  const responses=await Promise.all([f.save(source),f.save(source)]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[201,429]);assert.equal(f.machineFor('owner',source.id).runtime.captures,2);
});

test('downgrades preserve saved workspaces and usage without allowing new over-budget captures',async()=>{
  const f=fixture('pro'),source=(await f.start({size:'xl'})).data.containers[0],saved=(await f.save(source,{stop:true})).data;
  f.setPlan('builder');assert.equal((await f.call('/workspaces?workspaceId='+saved.id)).data.expiresAt,saved.expiresAt);
  assert.equal((await f.start({workspaceId:saved.id})).status,200);
  const running=(await f.call('/containers')).data.containers[0];assert.equal((await f.save(running)).status,429);
  await f.call('/workspaces?workspaceId='+saved.id,'DELETE');
  assert.equal((await f.call('/workspaces')).data.usage.retainedCaptureBytes,20e9);
});

test('legacy missing receipts migrate conservatively and do not refund capture history',async()=>{
  const f=fixture(),storage=f.accountFor('owner').ctx.storage;
  await storage.put('workspaceIndex',{records:[],usage:{'2026-10':2}});
  const first=(await f.call('/workspaces')).data.usage;
  assert.equal(first.savesThisMonth,2);assert.equal(first.captureBytesThisMonth,40e9);assert.equal(first.retainedCaptureBytes,40e9);
  assert.deepEqual((await f.call('/workspaces')).data.usage,first);
  const source=(await f.start()).data.containers[0];assert.equal((await f.save(source)).data.error,'workspace_capture_budget_exceeded');
  assert.equal(f.machineFor('owner',source.id).runtime.captures,0);
});
test('completed stop with a lost response reconciles without stopping the replacement',async()=>{
  const f=fixture(),source=(await f.start()).data.containers[0],machine=f.machineFor('owner','small'),original=machine.fetch;
  let lost=true;machine.fetch=async req=>{const response=await original(req);if(lost&&req.method==='DELETE'){lost=false;throw new Error();}return response;};
  assert.equal((await f.save(source,{stop:true},'stop-lost')).status,503);
  await f.start();const replacement=machine.runtime.starts.length;
  assert.equal((await f.save(source,{stop:true},'stop-lost')).data.stopCompleted,true);assert.equal(machine.runtime.running,true);assert.equal(machine.runtime.starts.length,replacement);
});

test('retained workspace receipts are stored in bounded chunks and legacy indexes migrate',async()=>{
  const f=fixture(),account=f.accountFor('owner'),storage=account.ctx.storage,now=f.now();
  const records=Array.from({length:3000},(_,i)=>({id:String(i),expiresAt:now+86400_000,name:'x'.repeat(80),fingerprint:'x'.repeat(400),deleted:true,deletedAt:now}));
  await storage.put('workspaceIndex',{records,usage:{'2026-10':3000}});
  const originalPut=storage.put.bind(storage);storage.put=async(k,v)=>{assert.ok(Buffer.byteLength(JSON.stringify(v))<128*1024);return originalPut(k,v);};
  await account.workspaces.prune();
  assert.equal((await storage.get('workspaceIndex')).records,undefined);
  assert.equal((await account.workspaces.index()).records.length,3000);
  f.setTime(now+86400_000);await account.workspaces.prune();assert.equal((await account.workspaces.index()).records.length,0);
  assert.equal((await storage.list({prefix:'workspaceIndex:'})).size,0);
});

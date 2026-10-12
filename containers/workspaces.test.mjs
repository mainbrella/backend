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
      const runtime={running:false,images:{terminal:'registry/image@sha256:'+'a'.repeat(64)},starts:[],execCalls:[],captures:0,files:{},
        start(options){this.starts.push(options);if(this.restoreFails&&options.containerSnapshot)throw new Error('provider-private-details');this.running=true;this.files=options.containerSnapshot?structuredClone(snapshots.get(options.containerSnapshot.id)):{};},
        async snapshotContainer(){this.captures++;if(this.captureFails)throw new Error();if(this.gate)await this.gate;const handle={id:crypto.randomUUID(),size:2048};snapshots.set(handle.id,structuredClone(this.files));return handle;},
        async setInactivityTimeout(){},async destroy(){this.running=false;},async exec(argv){this.execCalls.push(argv);return {output:async()=>({exitCode:0})};}};
      const ctx={storage:new Storage(),container:runtime},controller=new UserContainerController(ctx,()=>now);
      machines.set(name,{ctx,controller,runtime,fetch:req=>controller.fetch(req)});
    }return machines.get(name);
  };
  const accountFor=user=>{if(!accounts.has(user))accounts.set(user,new ContainerAccountController({storage:new Storage()},machineFor,()=>now,async()=> 'invoice_test'));return accounts.get(user);};
  const call=async(path,method='GET',body,headers={},user='owner')=>{
    const response=await accountFor(user).fetch(new Request('https://internal'+path,{method,headers:{'x-mainbrella-user':user,
      ...entitlementHeaders({active:paid,plan:paid?plan:null,validUntil:paid?now+90*86400_000:null,checkedAt:now,...(plan==='usage'?{billing:{customerId:'cus_owner',subscriptionId:'sub_owner',periodStart:Date.UTC(2026,9,1),periodEnd:Date.UTC(2026,10,1)}}:{})}),...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})}));
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
  assert.equal(runtime.execCalls.length,2);
  assert.deepEqual(runtime.execCalls.at(-1),['sh','-lc','hostname mainbrella || true; uname -a']);
  assert.equal((await f.start({workspaceId:saved.data.id},'restore-key')).data.creation.id,restored.data.creation.id);
  assert.equal(restored.data.usage.starts,2);
  const stale=await f.call('/containers?id=small&createdAt='+encodeURIComponent(source.createdAt),'DELETE');assert.equal(stale.status,409);assert.equal(runtime.running,true);
});
test('saved launch recipe is canonical, immutable on keyed save, and never launches in the source',async()=>{
  const f=fixture(),source=(await f.start()).data.containers[0],sourceMachine=f.machineFor('owner',source.id);
  sourceMachine.runtime.files={document:'source preserved'};
  const launch={command:'npm start',readiness:{port:3000}};
  const saved=await f.save(source,{launch},'save-launch');assert.equal(saved.status,201);
  assert.deepEqual(saved.data.launch,{command:'npm start',cwd:'/workspace',readiness:{port:3000,path:'/',timeoutMs:30000}});
  const replay=await f.save(source,{launch:{readiness:{timeoutMs:30000,path:'/',port:3000},cwd:'/workspace',command:'npm start'}},'save-launch');
  assert.equal(replay.status,200);assert.equal(replay.data.id,saved.data.id);assert.equal(sourceMachine.runtime.captures,1);
  assert.equal((await f.save(source,{launch:{...launch,command:'another command'}},'save-launch')).status,409);
  const target=f.machineFor('owner','c1');target.runtime.getTcpPort=()=>({fetch:async()=>new Response('healthy')});
  const restored=await f.start({workspaceId:saved.data.id},'restore-launch');assert.equal(restored.status,200);
  assert.ok(['starting','ready'].includes(restored.data.creation.readiness.status));
  await Promise.all([...target.controller.restoreReadinessTasks.values()]);
  const again=await f.start({workspaceId:saved.data.id},'restore-launch');
  assert.equal(again.data.creation.readiness.status,'ready');assert.equal(again.data.creation.createdAt,restored.data.creation.createdAt);
  assert.equal(target.runtime.starts.length,1);assert.equal(target.runtime.starts[0].entrypoint[3],'mainbrella-restore');
  assert.equal(sourceMachine.runtime.starts.length,1);assert.deepEqual(sourceMachine.runtime.starts[0].entrypoint,['sleep','infinity']);
  assert.deepEqual(sourceMachine.runtime.files,{document:'source preserved'});
  assert.equal((await f.call('/workspaces?workspaceId='+saved.data.id)).data.launch.command,'npm start');
});
test('lost restore response and account restart reconcile the launched generation without running its recipe twice',async()=>{
  const f=fixture(),source=(await f.start()).data.containers[0],saved=(await f.save(source,{launch:{command:'npm start',readiness:{port:3000}}})).data;
  const target=f.machineFor('owner','c1'),original=target.fetch;let lost=true;
  target.runtime.getTcpPort=()=>({fetch:async()=>new Response('healthy')});
  target.fetch=async request=>{const response=await original(request);if(lost&&new URL(request.url).pathname==='/container/workspace-launch-v1'){lost=false;throw new Error('response_lost');}return response;};
  assert.equal((await f.start({workspaceId:saved.id},'lost-restore')).status,503);
  await Promise.all([...target.controller.restoreReadinessTasks.values()]);
  const account=f.accountFor('owner');f.accounts.set('owner',new ContainerAccountController(account.ctx,f.machineFor,f.now));
  assert.equal((await f.start({workspaceId:saved.id},'lost-restore')).data.creation.status,'starting');
  f.setTime(f.now()+90001);
  const replay=await f.start({workspaceId:saved.id},'lost-restore');assert.equal(replay.status,200);
  assert.equal(replay.data.creation.readiness.status,'ready');assert.equal(target.runtime.starts.length,1);
  assert.equal(replay.data.usage.starts,2);
});
test('unsupported restore-launch runtime and malformed recipes fail before any restore start',async()=>{
  const f=fixture(),source=(await f.start()).data.containers[0];
  assert.equal((await f.save(source,{launch:{command:'npm start',readiness:{port:22}}})).data.error,'invalid_launch_recipe');
  const saved=(await f.save(source,{launch:{command:'npm start',readiness:{port:3000}}})).data;
  const target=f.machineFor('owner','c1'),original=target.fetch;
  target.fetch=request=>new URL(request.url).pathname==='/workspaces/restore-preflight-v1'?Promise.resolve(Response.json({compatible:true})):original(request);
  const denied=await f.start({workspaceId:saved.id});assert.equal(denied.status,503);assert.equal(denied.data.error,'workspace_launch_unavailable');
  assert.equal(target.runtime.starts.length,0);assert.equal((await f.call('/containers')).data.usage.starts,1);
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
  assert.deepEqual((await f.call('/workspaces')).data.usage,{saved:1,reservedBytes:2_000_000_000,savesThisMonth:1,captureBytesThisMonth:2_000_000_000,retainedCaptureBytes:2_000_000_000,
    captureBudgetResetsAt:Date.UTC(2026,10,1),nextRetainedCaptureReleaseAt:f.now()+WORKSPACE_CAPTURE_RETENTION_MS,nextRetainedCaptureReleaseBytes:2_000_000_000});
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


const lifecycle = (f, action, source, key=crypto.randomUUID(), extra={}) => f.call(`/containers/${action}`, 'POST', {id:source.id,createdAt:source.createdAt,...extra}, {'Idempotency-Key':key});

test('ordinary source startup configuration survives stop/resume/fork without launching the source or changing old saves',async()=>{
  const f=fixture('pro'),source=(await f.start()).data.containers[0],machine=f.machineFor('owner',source.id);
  machine.runtime.files={app:'prepared'};
  const before=(await f.save(source)).data;
  const recipe={command:'node server.mjs',cwd:'/workspace/app',readiness:{port:3000}};
  const configure=(value,identity=source,user='owner')=>f.call('/containers/startup','PATCH',{id:identity.id,createdAt:identity.createdAt,launch:value},{},user);
  const configured=await configure(recipe);assert.equal(configured.status,200);
  assert.deepEqual(configured.data,{id:source.id,createdAt:source.createdAt,launch:{...recipe,readiness:{port:3000,path:'/',timeoutMs:30000}}});
  assert.deepEqual((await configure(recipe)).data,configured.data);
  assert.equal(machine.runtime.starts.length,1);assert.equal(machine.runtime.execCalls.length,1);
  assert.deepEqual((await f.call('/containers')).data.containers[0].launch,configured.data.launch);
  assert.equal((await f.call('/workspaces?workspaceId='+before.id)).data.launch,undefined);
  assert.equal((await f.save(source)).data.launch,undefined);
  assert.equal((await configure(recipe,source,'other')).status,409);
  assert.equal((await configure(recipe,{...source,createdAt:new Date(f.now()+1).toISOString()})).status,409);
  assert.equal((await configure({...recipe,readiness:{port:22}})).status,400);
  assert.equal((await f.call('/containers/startup','PATCH',{id:source.id,createdAt:source.createdAt})).status,400);
  const clone=f.machineFor('owner','c1');clone.runtime.getTcpPort=()=>({fetch:async()=>new Response('healthy')});
  const forked=await lifecycle(f,'fork',source,'configured-fork');assert.equal(forked.status,200);
  await Promise.all([...clone.controller.restoreReadinessTasks.values()]);
  assert.equal(clone.runtime.starts[0].entrypoint[4],recipe.command);
  assert.equal((await lifecycle(f,'fork',source,'configured-fork')).data.creation.readiness.status,'ready');
  assert.equal(clone.runtime.starts.length,1);
  const stopped=await lifecycle(f,'stop',source,'configured-stop');assert.equal(stopped.status,200);
  assert.deepEqual(stopped.data.containers.find(c=>c.id===source.id).launch,configured.data.launch);
  assert.equal((await configure(recipe)).status,409);
  machine.runtime.getTcpPort=()=>({fetch:async()=>new Response('healthy')});
  const resumed=await lifecycle(f,'resume',source,'configured-resume');assert.equal(resumed.status,200);
  await Promise.all([...machine.controller.restoreReadinessTasks.values()]);
  assert.equal(machine.runtime.starts.at(-1).entrypoint[4],recipe.command);assert.equal(machine.runtime.starts.length,2);
  const current=resumed.data.containers.find(c=>c.id===source.id);
  assert.equal((await configure(null,source)).status,409);
  assert.equal((await configure(null,current)).data.launch,null);
  assert.equal((await f.call('/containers')).data.containers.find(c=>c.id===source.id).launch,undefined);
  assert.equal(machine.runtime.running,true);assert.equal(machine.runtime.starts.length,2);
  assert.equal((await f.call('/containers')).data.containers.find(c=>c.id===source.id).readiness.status,'ready');
  await f.call(`/containers?id=${forked.data.creation.containerId}`,'DELETE');
  const noStartup=await lifecycle(f,'fork',current,'cleared-fork');assert.equal(noStartup.status,200);
  assert.deepEqual(clone.runtime.starts.at(-1).entrypoint,['sleep','infinity']);
});

test('startup configuration rejects stale runtime generations, incompatible runtime, and production supervision',async()=>{
  const f=fixture(),source=(await f.start()).data.containers[0],machine=f.machineFor('owner',source.id);
  const body={id:source.id,createdAt:source.createdAt,launch:{command:'npm start',readiness:{port:3000}}};
  const delegate=machine.fetch;
  machine.fetch=async request=>new URL(request.url).pathname==='/workspaces/startup-v1'?new Response('Not found',{status:404}):delegate(request);
  assert.equal((await f.call('/containers/startup','PATCH',body)).data.error,'workspace_launch_unavailable');
  machine.fetch=async request=>{
    if(new URL(request.url).pathname==='/workspaces/startup-v1'){
      const metadata=await machine.ctx.storage.get('builderMachine');metadata.createdAt++;await machine.ctx.storage.put('builderMachine',metadata);
    }
    return delegate(request);
  };
  assert.equal((await f.call('/containers/startup','PATCH',body)).status,409);
  assert.equal((await machine.ctx.storage.get('builderMachine')).restoreLaunch,undefined);
  const production=fixture('usage'),service=(await production.start({lifecycle:'production',startupCommand:'node server.mjs'})).data.containers[0];
  assert.equal((await production.call('/containers/startup','PATCH',{...body,id:service.id,createdAt:service.createdAt})).data.error,'invalid_lifecycle');
});

test('stop, resume and fork inherit the launch recipe after the original workspace is deleted',async()=>{
  const f=fixture(),source=(await f.start()).data.containers[0];
  const saved=(await f.save(source,{stop:true,launch:{command:'npm start',readiness:{port:3000}}})).data;
  const target=f.machineFor('owner',source.id);target.runtime.getTcpPort=()=>({fetch:async()=>new Response('healthy')});
  let restored=await f.start({workspaceId:saved.id});assert.equal(restored.status,200);
  await Promise.all([...target.controller.restoreReadinessTasks.values()]);
  const app=restored.data.containers[0];
  assert.equal('_restoreLaunch' in app,false);
  assert.equal((await f.call('/workspaces?workspaceId='+saved.id,'DELETE')).status,200);
  assert.equal((await lifecycle(f,'stop',app,'recipe-stop')).status,200);
  const checkpoint=(await f.accountFor('owner').workspaces.index()).records.find(record=>record.operationKey==='stop:recipe-stop');
  assert.deepEqual(checkpoint.launch,saved.launch);
  const account=f.accountFor('owner');f.accounts.set('owner',new ContainerAccountController(account.ctx,f.machineFor,f.now));
  const resumed=await lifecycle(f,'resume',app,'recipe-resume');assert.equal(resumed.status,200);
  await Promise.all([...target.controller.restoreReadinessTasks.values()]);
  assert.equal(target.runtime.starts.at(-1).entrypoint[4],'npm start');
  assert.equal(target.runtime.starts.length,3);
  const current=resumed.data.containers[0];assert.notEqual(current.createdAt,app.createdAt);
  const forkTarget=f.machineFor('owner','c1');forkTarget.runtime.getTcpPort=()=>({fetch:async()=>new Response('healthy')});
  const forked=await lifecycle(f,'fork',current,'recipe-fork');assert.equal(forked.status,200);
  await Promise.all([...forkTarget.controller.restoreReadinessTasks.values()]);
  assert.equal(forkTarget.runtime.starts.length,1);assert.equal(forkTarget.runtime.starts[0].entrypoint[4],'npm start');
  assert.equal(target.runtime.starts.length,3);assert.equal(target.runtime.running,true);
  const replay=await lifecycle(f,'fork',current,'recipe-fork');assert.equal(replay.status,200);
  assert.equal(replay.data.creation.readiness.status,'ready');assert.equal(forkTarget.runtime.starts.length,1);
  assert.ok(replay.data.containers.every(container=>!('_restoreLaunch' in container)));
});

test('safe stop preserves bytes, reserves identity without compute, and resumes with a fresh generation after eviction', async()=>{
  const f=fixture(),source=(await f.start({name:'Development'})).data.containers[0],runtime=f.machineFor('owner',source.id).runtime;
  runtime.files={binary:new Uint8Array([0,255]),nested:'saved'};
  const stopped=await lifecycle(f,'stop',source,'stop-1');assert.equal(stopped.status,200);
  assert.equal(stopped.data.containers[0].status,'stopped');assert.equal(stopped.data.containers[0].id,source.id);
  assert.ok(stopped.data.containers[0].persistenceExpiresAt>f.now());assert.equal(stopped.data.usage.concurrentComputeUnits,0);
  assert.equal(stopped.data.usage.reservedComputeUnitHours,0);assert.equal(runtime.running,false);
  const account=f.accountFor('owner');f.accounts.set('owner',new ContainerAccountController(account.ctx,f.machineFor,f.now));
  const other=(await f.start()).data.containers.find(c=>c.status==='running');assert.notEqual(other.id,source.id);
  const resumed=await lifecycle(f,'resume',source,'resume-1');assert.equal(resumed.status,200);
  const current=resumed.data.containers.find(c=>c.id===source.id);assert.equal(current.status,'running');assert.equal(current.name,'Development');assert.notEqual(current.createdAt,source.createdAt);
  assert.deepEqual(runtime.files,{binary:new Uint8Array([0,255]),nested:'saved'});
  assert.equal((await lifecycle(f,'resume',source,'resume-1')).data.creation.id,resumed.data.creation.id);assert.equal(runtime.starts.length,2);
  assert.equal((await lifecycle(f,'stop',source,'stop-1')).status,200);assert.equal(runtime.running,true);
  assert.equal((await lifecycle(f,'stop',source,'stale-stop')).status,409);assert.equal(runtime.running,true);
  assert.equal((await f.call('/containers?id=small&createdAt='+encodeURIComponent(source.createdAt),'DELETE')).status,409);assert.equal(runtime.running,true);
});

test('lost stop response is replayed after controller eviction without recapture or restarting compute',async()=>{
  const f=fixture(),source=(await f.start()).data.containers[0],machine=f.machineFor('owner',source.id),original=machine.fetch;
  let lost=true;machine.fetch=async request=>{const response=await original(request);if(lost&&request.method==='DELETE'){lost=false;throw new Error('response_lost');}return response;};
  assert.equal((await lifecycle(f,'stop',source,'lost-stop')).status,503);assert.equal(machine.runtime.running,false);
  const account=f.accountFor('owner');f.accounts.set('owner',new ContainerAccountController(account.ctx,f.machineFor,f.now));
  const retried=await lifecycle(f,'stop',source,'lost-stop');assert.equal(retried.status,200);assert.equal(retried.data.containers[0].status,'stopped');assert.equal(machine.runtime.captures,1);
  assert.equal((await lifecycle(f,'stop',{...source,createdAt:new Date(f.now()+1).toISOString()},'lost-stop')).status,409);
});

test('failed and ambiguous stop captures retain the live source and never recapture an uncertain provider operation',async()=>{
  const f=fixture(),source=(await f.start()).data.containers[0],runtime=f.machineFor('owner',source.id).runtime;
  runtime.files={important:'keep'};runtime.captureFails=true;
  assert.equal((await lifecycle(f,'stop',source,'failed-capture')).status,503);assert.equal(runtime.running,true);
  runtime.captureFails=false;assert.equal((await lifecycle(f,'stop',source,'failed-capture')).status,503);
  assert.equal(runtime.captures,1);assert.deepEqual(runtime.files,{important:'keep'});
  assert.equal((await lifecycle(f,'stop',source,'new-operation')).status,200);assert.equal(runtime.captures,2);
});

test('expired or deleted stop snapshots never launch an empty replacement and deletion frees the suspended identity',async()=>{
  const f=fixture(),source=(await f.start()).data.containers[0];
  const stopped=(await lifecycle(f,'stop',source)).data.containers[0],runtime=f.machineFor('owner',source.id).runtime;
  f.setTime(stopped.persistenceExpiresAt);
  assert.equal((await lifecycle(f,'resume',source)).status,410);assert.equal(runtime.starts.length,1);
  assert.equal((await f.call('/containers')).data.containers[0].stopReason,'workspace_expired');
  const deleted=await f.call('/containers?id=small&createdAt='+encodeURIComponent(source.createdAt),'DELETE');assert.equal(deleted.status,200);assert.deepEqual(deleted.data.containers,[]);
  const next=(await f.start()).data.containers[0];assert.equal(next.id,source.id);assert.notEqual(next.createdAt,source.createdAt);
  const again=(await lifecycle(f,'stop',next)).data.containers[0];
  await f.call('/workspaces?workspaceId='+again.workspaceId,'DELETE');assert.equal((await lifecycle(f,'resume',next)).status,404);assert.equal(runtime.starts.length,2);
});

test('failed restore retains the suspended checkpoint for a later explicitly keyed retry',async()=>{
  const f=fixture(),source=(await f.start()).data.containers[0],runtime=f.machineFor('owner',source.id).runtime;
  runtime.files={data:'preserved'};await lifecycle(f,'stop',source);runtime.restoreFails=true;
  assert.equal((await lifecycle(f,'resume',source,'bad-restore')).data.error,'workspace_restore_failed');
  assert.ok(runtime.starts.at(-1).containerSnapshot);assert.equal(runtime.starts.at(-1).image,undefined);
  f.setTime(f.now()+91000);assert.equal((await f.call('/containers')).data.containers[0].status,'stopped');
  runtime.restoreFails=false;assert.equal((await lifecycle(f,'resume',source,'good-restore')).status,200);assert.deepEqual(runtime.files,{data:'preserved'});
});

test('filesystem fork keeps the source running and mutations isolated, with idempotent creation and generation fencing',async()=>{
  const f=fixture(),source=(await f.start()).data.containers[0],runtime=f.machineFor('owner',source.id).runtime;
  runtime.files={dependencies:'installed'};
  const forked=await lifecycle(f,'fork',source,'fork-1',{name:'Branch'});assert.equal(forked.status,200);
  const clone=forked.data.containers.find(c=>c.id!==source.id),cloneRuntime=f.machineFor('owner',clone.id).runtime;
  assert.equal(clone.name,'Branch');assert.equal(runtime.running,true);assert.deepEqual(cloneRuntime.files,runtime.files);
  cloneRuntime.files.dependencies='changed';assert.equal(runtime.files.dependencies,'installed');
  assert.equal((await lifecycle(f,'fork',source,'fork-1',{name:'Branch'})).data.creation.id,forked.data.creation.id);assert.equal(runtime.captures,1);
  assert.equal((await lifecycle(f,'fork',source,'fork-1',{name:'Changed'})).status,409);
  assert.equal((await lifecycle(f,'fork',{...source,createdAt:new Date(f.now()+1).toISOString()})).status,409);
  assert.equal((await f.call('/containers/fork','POST',{id:source.id,createdAt:source.createdAt},{'Idempotency-Key':'other'},'other')).status,409);
});

test('fork capture replay can finish after source deletion, with no second provider capture',async()=>{
  const f=fixture(),source=(await f.start()).data.containers[0],runtime=f.machineFor('owner',source.id).runtime;
  runtime.files={marker:'checkpoint'};
  // Persist a capture but fail preflight before the target creation reservation.
  const target=f.machineFor('owner','c1'),original=target.fetch;
  target.fetch=async request=>new URL(request.url).pathname==='/workspaces/restore-preflight-v1'?Response.json({error:'unavailable'},{status:503}):original(request);
  assert.equal((await lifecycle(f,'fork',source,'retry-fork')).status,503);assert.equal(runtime.captures,1);
  await f.call('/containers?id=small&createdAt='+encodeURIComponent(source.createdAt),'DELETE');target.fetch=original;
  const retried=await lifecycle(f,'fork',source,'retry-fork');assert.equal(retried.status,200);assert.equal(runtime.captures,1);
  assert.deepEqual(f.machineFor('owner',retried.data.creation.containerId).runtime.files,{marker:'checkpoint'});
});

test('fork and normal create cannot share an idempotency key and capacity rejection captures nothing',async()=>{
  const f=fixture(),first=await f.start({},'normal-key'),source=first.data.containers[0],runtime=f.machineFor('owner',source.id).runtime;
  assert.equal((await lifecycle(f,'fork',source,'normal-key')).status,409);assert.equal(runtime.captures,0);
  for(let i=0;i<4;i++)assert.equal((await f.start()).status,200);
  assert.equal((await lifecycle(f,'fork',source)).data.error,'container_limit_exceeded');assert.equal(runtime.captures,0);
});

test('production explicit stop prevents recovery until resume and restores the latest stop checkpoint on later recovery',async()=>{
  const f=fixture('usage'),source=(await f.start({lifecycle:'production',startupCommand:'node server.js',name:'Service'})).data.containers[0],runtime=f.machineFor('owner',source.id).runtime;
  runtime.files={upload:'saved'};assert.equal((await lifecycle(f,'stop',source)).status,200);
  assert.equal((await f.call('/containers')).data.containers[0].status,'stopped');assert.equal(runtime.starts.length,1);
  const resumed=await lifecycle(f,'resume',source);assert.equal(resumed.status,200);
  const current=resumed.data.containers[0];assert.equal(current.lifecycle,'production');assert.equal(current.name,'Service');assert.deepEqual(runtime.files,{upload:'saved'});
  assert.ok(runtime.starts.at(-1).entrypoint.join(' ').includes('node server.js'));
  runtime.files.unsaved='not checkpointed';runtime.running=false;
  const recovered=await f.call('/containers');assert.equal(recovered.status,200);assert.equal(recovered.data.containers[0].createdAt,current.createdAt);
  assert.deepEqual(runtime.files,{upload:'saved'});assert.ok(runtime.starts.at(-1).containerSnapshot);
});


test('resuming pending status never lets the old stopped generation delete the replacement',async()=>{
  const f=fixture(),source=(await f.start()).data.containers[0],machine=f.machineFor('owner',source.id);
  await lifecycle(f,'stop',source);
  let release,entered;
  const booted=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const exec=machine.runtime.exec;
  machine.runtime.exec=async function(argv){entered();await gate;return exec.call(this,argv);};
  const resume=lifecycle(f,'resume',source);await booted;
  try{
    const pending=await f.call('/containers');assert.equal(pending.data.containers[0].status,'starting');assert.notEqual(pending.data.containers[0].createdAt,source.createdAt);
    assert.equal((await f.call('/containers?id=small&createdAt='+encodeURIComponent(source.createdAt),'DELETE')).status,409);
  }finally{release();}
  assert.equal((await resume).status,200);assert.equal(machine.runtime.running,true);
});

test('production recovery cannot resurrect a deleted filesystem checkpoint or fall back to its image',async()=>{
  const f=fixture('usage'),source=(await f.start({lifecycle:'production',startupCommand:'node app.js'})).data.containers[0],runtime=f.machineFor('owner',source.id).runtime;
  const stopped=(await lifecycle(f,'stop',source)).data.containers[0];await lifecycle(f,'resume',source);
  await f.call('/workspaces?workspaceId='+stopped.workspaceId,'DELETE');runtime.running=false;
  const recovered=await f.call('/containers');assert.equal(recovered.data.containers[0].status,'stopped');assert.equal(recovered.data.containers[0].stopReason,'workspace_not_found');assert.equal(runtime.starts.length,2);
});

test('stop/resume and forks retain outbound restrictions and vault bindings without exposing provider handles',async()=>{
  const f=fixture(),account=f.accountFor('owner'),policy={allow:['api.example.com'],deny:[]},bindings=['sec_00000000-0000-4000-8000-000000000001'];
  account.security={validateSelection:async()=>null};
  for(const id of ['small','c1'])f.machineFor('owner',id).controller.security={available:()=>true,install:async()=>{}};
  const source=(await f.start({networkPolicy:policy,secretBindings:bindings})).data.containers[0];assert.deepEqual(source.networkPolicy,policy);
  const forked=await lifecycle(f,'fork',source),clone=forked.data.containers.find(c=>c.id!==source.id);assert.equal(forked.status,200);assert.deepEqual(clone.networkPolicy,policy);assert.deepEqual(clone.secretBindings,bindings);
  assert.equal(f.machineFor('owner',clone.id).runtime.starts[0].enableInternet,false);
  const stopped=await lifecycle(f,'stop',source);assert.equal(stopped.status,200);assert.ok(!JSON.stringify(stopped.data).includes('containerSnapshot'));
  const resumed=await lifecycle(f,'resume',source);assert.equal(resumed.status,200);const current=resumed.data.containers.find(c=>c.id===source.id);
  assert.deepEqual(current.networkPolicy,policy);assert.deepEqual(current.secretBindings,bindings);assert.equal(f.machineFor('owner',source.id).runtime.starts.at(-1).enableInternet,false);
});

test('lost capture receipts remain recoverable after the source runtime stops, without recapture',async()=>{
  for(const action of ['stop','save']){
    const f=fixture(),source=(await f.start({name:'Durable receipt'})).data.containers[0],machine=f.machineFor('owner',source.id),original=machine.fetch;
    machine.runtime.files={important:'receipt-backed'};let lost=true;
    machine.fetch=async request=>{const response=await original(request);if(lost&&new URL(request.url).pathname==='/workspaces/snapshot-v1'){lost=false;throw new Error('response_lost');}return response;};
    const call=()=>action==='stop'?lifecycle(f,'stop',source,'receipt-key'):f.save(source,{stop:true},'receipt-key');
    assert.equal((await call()).status,503);machine.runtime.running=false;
    const recovered=await call();assert.ok([200,201].includes(recovered.status),JSON.stringify(recovered));assert.equal(machine.runtime.captures,1);
    if(action==='stop'){
      assert.equal(recovered.data.containers[0].status,'stopped');assert.equal(recovered.data.containers[0].name,'Durable receipt');
      assert.equal((await lifecycle(f,'resume',source)).status,200);assert.deepEqual(machine.runtime.files,{important:'receipt-backed'});
    }else assert.equal(recovered.data.stopCompleted,true);
  }
});

test('workspace chunks remain below provider value limits with maximum outbound policy metadata',async()=>{
  const f=fixture(),account=f.accountFor('owner'),storage=account.ctx.storage;
  const networkPolicy={allow:Array.from({length:64},(_,i)=>`${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${i}.example.com`),deny:Array.from({length:64},(_,i)=>`${'d'.repeat(63)}.${'e'.repeat(63)}.${'f'.repeat(63)}.${i}.example.com`)};
  const records=Array.from({length:40},(_,i)=>({id:String(i),networkPolicy,name:'x'.repeat(80),expiresAt:f.now()+86400000}));
  const put=storage.put.bind(storage);storage.put=async(k,v)=>{assert.ok(Buffer.byteLength(JSON.stringify(v))<128*1024);return put(k,v);};
  await account.workspaces.persist({records,usage:{},captureUsage:{}});assert.deepEqual((await account.workspaces.index()).records,records);
});


test('oversized account policy growth rejects creation and fork before capture or compute reservation',async()=>{
  const f=fixture(),account=f.accountFor('owner'),policy={allow:['api.example.com'],deny:[]};
  account.security={validateSelection:async()=>null};f.machineFor('owner','small').controller.security={available:()=>true,install:async()=>{}};
  const source=(await f.start({networkPolicy:policy})).data.containers[0],runtime=f.machineFor('owner',source.id).runtime;
  const state=await account.ctx.storage.get('containerAccount');state.retainedAccountingEvidence='x'.repeat(112*1024);await account.ctx.storage.put('containerAccount',state);
  const rejected=await f.start({networkPolicy:policy});assert.equal(rejected.status,409);assert.equal(rejected.data.error,'network_policy_capacity_exceeded');
  assert.equal((await lifecycle(f,'fork',source)).data.error,'network_policy_capacity_exceeded');assert.equal(runtime.captures,0);
  assert.equal((await f.call('/containers')).data.usage.starts,1);
});


test('revoked secret bindings reject a fork before snapshot cost',async()=>{
  const f=fixture(),account=f.accountFor('owner');account.security={validateSelection:async()=>null};
  f.machineFor('owner','small').controller.security={available:()=>true,install:async()=>{}};
  const source=(await f.start({networkPolicy:{allow:['api.example.com']},secretBindings:['sec_00000000-0000-4000-8000-000000000001']})).data.containers[0];
  account.security.validateSelection=async()=> 'secret_not_found';
  const fork=await lifecycle(f,'fork',source);assert.equal(fork.status,404);assert.equal(fork.data.error,'secret_not_found');assert.equal(f.machineFor('owner',source.id).runtime.captures,0);
});


test('a lost stop capture can recover its workspace without stopping a newer slot generation',async()=>{
  const f=fixture(),source=(await f.start()).data.containers[0],machine=f.machineFor('owner',source.id),original=machine.fetch;let lost=true;
  machine.runtime.files={old:'checkpoint'};
  machine.fetch=async request=>{const response=await original(request);if(lost&&new URL(request.url).pathname==='/workspaces/snapshot-v1'){lost=false;throw new Error('response_lost');}return response;};
  assert.equal((await lifecycle(f,'stop',source,'old-capture')).status,503);machine.runtime.running=false;
  const replacement=(await f.start()).data.containers[0];assert.equal(replacement.id,source.id);assert.notEqual(replacement.createdAt,source.createdAt);
  assert.equal((await lifecycle(f,'stop',source,'old-capture')).status,409);assert.equal(machine.runtime.running,true);assert.equal(machine.runtime.captures,1);
  const saved=(await f.call('/workspaces')).data.workspaces[0];assert.equal(saved.status,'ready');
  const restored=await f.start({workspaceId:saved.id});assert.equal(restored.status,200);assert.deepEqual(f.machineFor('owner',restored.data.creation.containerId).runtime.files,{old:'checkpoint'});
});

test('workspace accounting distinguishes snapshot bytes, live reservations and retained budget release',async()=>{
  const f=fixture('scale'),source=(await f.start()).data.containers[0],firstAt=f.now();
  const first=(await f.save(source)).data;
  assert.equal(first.bytes,2048);assert.equal(first.reservedBytes,2_000_000_000);
  f.setTime(firstAt+60_000);
  const second=(await f.save(source)).data;
  await f.call('/workspaces?workspaceId='+first.id,'DELETE');
  let usage=(await f.call('/workspaces')).data.usage;
  assert.equal(usage.reservedBytes,second.reservedBytes);
  assert.equal(usage.retainedCaptureBytes,4_000_000_000);
  assert.equal(usage.nextRetainedCaptureReleaseAt,firstAt+60_000+WORKSPACE_CAPTURE_RETENTION_MS);
  assert.equal(usage.nextRetainedCaptureReleaseBytes,4_000_000_000);
  assert.equal(usage.captureBudgetResetsAt,Date.UTC(2026,10,1));
  // A later day's capture releases independently; the earliest release is not
  // a promise to free all retained capacity or physically erase provider data.
  f.setTime(firstAt+86400_000);
  const laterSource=(await f.start()).data.containers[0];
  const third=(await f.save(laterSource)).data;
  usage=(await f.call('/workspaces')).data.usage;
  assert.equal(usage.retainedCaptureBytes,6_000_000_000);
  assert.equal(usage.nextRetainedCaptureReleaseBytes,4_000_000_000);
  f.setTime(second.expiresAt);
  assert.equal((await f.call('/workspaces?workspaceId='+second.id)).data.reservedBytes,0);
  await f.call('/workspaces?workspaceId='+third.id,'DELETE');
  f.setTime(firstAt+WORKSPACE_CAPTURE_RETENTION_MS);
  usage=(await f.call('/workspaces')).data.usage;
  assert.equal(usage.saved,0);assert.equal(usage.reservedBytes,0);
  assert.equal(usage.retainedCaptureBytes,6_000_000_000);
  assert.equal(usage.captureBytesThisMonth,0);
  f.setTime(firstAt+60_000+WORKSPACE_CAPTURE_RETENTION_MS);
  usage=(await f.call('/workspaces')).data.usage;
  assert.equal(usage.retainedCaptureBytes,2_000_000_000);
  assert.equal(usage.nextRetainedCaptureReleaseBytes,2_000_000_000);
  assert.equal(usage.nextRetainedCaptureReleaseAt,firstAt+86400_000+WORKSPACE_CAPTURE_RETENTION_MS);
  f.setTime(usage.nextRetainedCaptureReleaseAt);
  usage=(await f.call('/workspaces')).data.usage;
  assert.equal(usage.retainedCaptureBytes,0);
  assert.equal(usage.nextRetainedCaptureReleaseAt,null);
  assert.equal(usage.nextRetainedCaptureReleaseBytes,0);
});

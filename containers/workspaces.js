import { WORKSPACE_POLICY, WORKSPACE_OPERATION_RETENTION_MS, publicWorkspace, validWorkspaceId, validWorkspaceName, validGeneration } from './workspace-contract.js';
import { entitlementHeaders, requestEntitlement, validEntitlement, machineSize } from './plan-policy.js';
import { validContainerId, validIdempotencyKey } from './container-account-core.js';
import { readFileBytes } from './file-contract.js';

const KEY='workspaceIndex';
const fail=(code,status)=>Response.json({error:code},{status,headers:{'Cache-Control':'no-store'}});
// Uses the same account lock and owner namespace as start/stop. Provider handles
// never cross the public boundary. Capture intent precedes any provider call.
export class AccountWorkspaces {
  constructor(account){this.account=account;}
  async index(){return await this.account.ctx.storage.get(KEY) ?? {records:[],usage:{}};}
  async prune(){
    const index=await this.index(),now=this.account.now();
    index.records=index.records.filter(record=> (record.deleted ? record.deletedAt + WORKSPACE_OPERATION_RETENTION_MS : record.expiresAt+WORKSPACE_OPERATION_RETENTION_MS)>now);
    for(const record of index.records)if(record.expiresAt<=now || record.deleted){delete record.handle;record.reservedBytes=0;}
    const month=new Date(now).toISOString().slice(0,7);index.usage={[month]:index.usage[month]??0};
    await this.account.ctx.storage.put(KEY,index);
    return index;
  }
  async nextAlarm(){const index=await this.index(),now=this.account.now();return Math.min(Infinity,...index.records.map(r=>r.deleted?r.deletedAt+WORKSPACE_OPERATION_RETENTION_MS:r.expiresAt>now?r.expiresAt:r.expiresAt+WORKSPACE_OPERATION_RETENTION_MS));}
  async restoreSelection(state,selection){
    const index=await this.prune(),record=index.records.find(r=>r.id===selection.workspaceId);
    if(!record || record.deleted)throw new Error('workspace_not_found');
    if(record.expiresAt<=this.account.now())throw new Error('workspace_expired');
    if(!record.handle || record.archived)throw new Error('workspace_not_ready');
    if(selection.size!==undefined && selection.size!==record.size || selection.internet!==undefined && selection.internet!==record.internet)throw new Error('workspace_policy_conflict');
    return {...selection,size:record.size,internet:record.internet,imageKey:record.imageKey,imageDigest:record.imageDigest,
      imageId:record.imageId,imageName:record.imageName,containerSnapshot:record.handle,workspaceExpiresAt:record.expiresAt};
  }
  async fetch(request){
    const url=new URL(request.url),id=url.searchParams.get('workspaceId'),account=this.account;
    if([...url.searchParams.keys()].some(key=>key!=='workspaceId') || url.searchParams.getAll('workspaceId').length>1 || id && !validWorkspaceId(id))return fail('invalid_request',400);
    if(!['GET','POST','PATCH','DELETE'].includes(request.method))return fail('method_not_allowed',405);
    const userId=request.headers.get('x-mainbrella-user');if(!userId || !/^[A-Za-z0-9_-]{1,128}$/.test(userId))return fail('not_authenticated',401);
    let body;
    if(['POST','PATCH'].includes(request.method)){
      try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readFileBytes(request.body,2048,request.signal)));}catch{return fail('invalid_request',400);}
      if(!body || typeof body!=='object' || Array.isArray(body))return fail('invalid_request',400);
    }
    const key=request.headers.get('Idempotency-Key');
    if(request.method==='POST' && (!validIdempotencyKey(key) || id || Object.keys(body).some(k=>!['id','createdAt','name','stop'].includes(k)) || !validContainerId(body.id) || !validGeneration(body.createdAt) || !validWorkspaceName(body.name) || body.stop!==undefined && typeof body.stop!=='boolean'))return fail('invalid_request',400);
    if(request.method==='PATCH' && (!id || Object.keys(body).length===0 || Object.keys(body).some(k=>!['name','archived'].includes(k)) || body.name!==undefined&&!validWorkspaceName(body.name) || body.archived!==undefined&&typeof body.archived!=='boolean'))return fail('invalid_request',400);
    if(request.method==='DELETE'&&!id)return fail('invalid_request',400);
    try{return await account.serialized(async()=>{
      const state=await account.initialize(userId,requestEntitlement(request,account.now()));
      // Reads/delete/archive remain available without billing or runtime contact.
      const index=await this.prune(),now=account.now();
      if(request.method==='GET'){
        const records=index.records.filter(r=>!r.deleted);
        if(id){const record=records.find(r=>r.id===id);return record?account.respond(publicWorkspace(record,now)):fail('workspace_not_found',404);}
        return account.respond({workspaces:records.map(r=>publicWorkspace(r,now)),limits:WORKSPACE_POLICY[state.entitlement.plan]??null,
          usage:{saved:records.filter(r=>r.expiresAt>now).length,reservedBytes:records.reduce((sum,r)=>sum+(r.reservedBytes??0),0)}});
      }
      if(['PATCH','DELETE'].includes(request.method)){
        const record=index.records.find(r=>r.id===id);if(!record)return fail('workspace_not_found',404);
        if(request.method==='DELETE'){record.deleted=true;record.deletedAt??=now;delete record.handle;record.reservedBytes=0;}
        else {if(record.deleted)return fail('workspace_not_found',404);Object.assign(record,body);}
        await account.ctx.storage.put(KEY,index);await account.saveState(state);
        return request.method==='DELETE'?account.respond({deleted:true}):account.respond(publicWorkspace(record,now));
      }
      const fingerprint=JSON.stringify([body.id,body.createdAt,body.name,body.stop??false]);
      let record=index.records.find(r=>r.operationKey===key && r.operationExpiresAt>now);
      if(record && record.fingerprint!==fingerprint)return fail('idempotency_key_conflict',409);
      if(record?.deleted)return fail('workspace_not_found',404);
      if(record?.expiresAt<=now)return fail('workspace_expired',410);
      // Finished retries never need the original machine or subscription.
      if(record?.handle && (!record.stop || record.stopCompleted))return account.respond(publicWorkspace(record,now));
      const containers=await account.reconcile(state,requestEntitlement(request,now));
      if(!validEntitlement(state.entitlement,now))return fail('subscription_required',402);
      const source=containers.find(c=>c.id===body.id && c.createdAt===body.createdAt && c.status==='running');
      if(record?.handle && record.stop && !source){
        record.stopCompleted=true;await account.ctx.storage.put(KEY,index);await account.saveState(state);
        return account.respond(publicWorkspace(record,now));
      }
      if(!source)return fail('container_not_running',409);
      const runtime=account.machineFor(userId,body.id);
      if(!record){
        const features=await runtime.fetch(new Request('https://internal/features'));
        if(!features.ok || (await features.json()).workspaceSnapshots!==1)return fail('persistence_unavailable',503);
        const policy=WORKSPACE_POLICY[state.entitlement.plan],size=machineSize(source.size),reservedBytes=size.diskGB*1_000_000_000;
        const saved=index.records.filter(r=>!r.deleted&&r.expiresAt>now),month=new Date(now).toISOString().slice(0,7);
        if(saved.length>=policy.maxSaved || saved.reduce((sum,r)=>sum+(r.reservedBytes??0),0)+reservedBytes>policy.maxReservedBytes)return fail('workspace_quota_exceeded',429);
        if((index.usage[month]??0)>=policy.maxSavesPerMonth)return fail('workspace_save_limit',429);
        record={id:crypto.randomUUID(),name:body.name,source:{id:body.id,createdAt:body.createdAt},createdAt:new Date(now).toISOString(),expiresAt:now+policy.retentionMs,
          size:source.size,internet:source.internet??true,imageDigest:source.imageDigest,imageId:source.imageId,imageName:source.imageName,catalogId:source.catalogId,
          operationKey:key,operationExpiresAt:now+WORKSPACE_OPERATION_RETENTION_MS,fingerprint,reservedBytes,stop:body.stop??false};
        index.records.push(record);index.usage[month]=(index.usage[month]??0)+1;
        await account.ctx.storage.put(KEY,index);await account.saveState(state);
      }
      if(!record.handle){
        const response=await runtime.fetch(new Request('https://internal/workspaces/snapshot-v1',{method:'POST',headers:{...entitlementHeaders(state.entitlement),'Content-Type':'application/json'},body:JSON.stringify({id:record.id,createdAt:body.createdAt,expiresAt:record.expiresAt})}));
        const capture=await response.json();if(!response.ok)return fail(capture.error==='container_not_running'?'container_not_running':'workspace_save_unavailable',response.status===409?409:503);
        if(!capture.handle?.id || !Number.isSafeInteger(capture.handle.size) || capture.handle.size<0 || capture.handle.size>record.reservedBytes || capture.imageDigest!==record.imageDigest)return fail('workspace_save_unavailable',503);
        record.handle=capture.handle;record.bytes=capture.handle.size;record.imageKey=capture.imageKey;
        await account.ctx.storage.put(KEY,index);
      }
      if(record.stop){
        // Snapshot is durable before stop. Reservation fencing protects replacements.
        const stopped=await account.machine(state,body.id,'DELETE',state.entitlement);
        account.settleLease(state,body.id,stopped.lastRun?.stoppedAt??account.now());delete state.pending[body.id];record.stopCompleted=true;
        await account.ctx.storage.put(KEY,index);await account.reconcile(state,state.entitlement);
      }
      await account.saveState(state);return account.respond(publicWorkspace(record,account.now()),201);
    });}catch{return fail('workspaces_unavailable',503);}
  }
}

export async function captureWorkspace(controller,request){
  if(request.method!=='POST')return fail('method_not_allowed',405);
  let body;try{body=JSON.parse(new TextDecoder().decode(await readFileBytes(request.body,2048,request.signal)));}catch{return fail('invalid_request',400);}
  if(!validWorkspaceId(body?.id) || !validGeneration(body?.createdAt) || !Number.isSafeInteger(body?.expiresAt) || body.expiresAt<=controller.now())return fail('invalid_request',400);
  return controller.serialized(async()=>{
    // Durable receipts recover responses lost between snapshot and account commit.
    const receipts=await controller.ctx.storage.get('workspaceReceipts')??{};
    for(const [id,value]of Object.entries(receipts))if(value.expiresAt<=controller.now())delete receipts[id];
    if(receipts[body.id])return receipts[body.id].handle?controller.respond(receipts[body.id]):fail('workspace_save_unavailable',503);
    const metadata=await controller.ctx.storage.get('builderMachine');
    if(!controller.container.running || !metadata || new Date(metadata.createdAt).toISOString()!==body.createdAt || controller.now()>=controller.deadline(metadata) || !validEntitlement(requestEntitlement(request,controller.now()),controller.now()) || !await controller.hasPaidAccess())return fail('container_not_running',409);
    if(Object.keys(receipts).length>=100)return fail('workspace_save_unavailable',503);
    try{
      // If a DO restarts after the provider accepted capture but before its
      // handle was saved, the receipt remains ambiguous and is never recaptured.
      receipts[body.id]={expiresAt:Math.min(body.expiresAt,controller.now()+WORKSPACE_OPERATION_RETENTION_MS)};
      await controller.ctx.storage.put('workspaceReceipts',receipts);
      const handle=await controller.container.snapshotContainer({name:`workspace-${body.id}`});
      if(!handle?.id || !Number.isSafeInteger(handle.size) || handle.size<0)throw new Error();
      const receipt={handle,createdAt:body.createdAt,imageDigest:metadata.imageDigest,imageKey:metadata.imageKey??'terminal',expiresAt:Math.min(body.expiresAt,controller.now()+WORKSPACE_OPERATION_RETENTION_MS)};
      receipts[body.id]=receipt;await controller.ctx.storage.put('workspaceReceipts',receipts);return controller.respond(receipt);
    }catch{return fail('workspace_save_unavailable',503);}
  });
}

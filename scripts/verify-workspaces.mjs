import {randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseEnv} from 'node:util';
import {execFileSync} from 'node:child_process';
import {Mainbrella} from '../sdk/javascript/index.js';
const check=(value,code)=>{if(!value)throw new Error(code);};
const expected=async(action,status)=>{try{await action();}catch(error){check(error.status===status,'unexpected_rejection');return;}throw new Error('isolation_failed');};
export async function verifyWorkspaces(client,secondary,{checkpoint=async()=>{},verifyArchive=()=>{}}={}){
  const caps=await client.capabilities(),before=await client.list();
  check(caps.persistence?.snapshots===true&&caps.persistence?.exports===true,'persistence_unavailable');
  check(before.active&&!before.containers.length&&before.limits.maxStartsPerMonth-before.usage.starts>=2,'unsafe_account_state');
  const report={startedAt:new Date().toISOString(),maxStarts:2,startsRequested:0,beforeStarts:before.usage.starts,generations:[],checks:{},cleanup:'pending',ok:false};
  const saved=()=>checkpoint(structuredClone(report));let workspace,source,restored;const owned=[];
  const create=async(body)=>{
    const intent={key:randomUUID(),body};report.generations.push(intent);report.startsRequested++;await saved();
    const data=await client.request('/containers',{method:'POST',body,headers:{'Idempotency-Key':intent.key},signal:AbortSignal.timeout(90_000)});
    const selected=data.containers?.find(c=>c.id===data.creation?.containerId&&c.createdAt===data.creation?.createdAt&&c.status==='running');
    check(data.creation?.status==='running'&&selected,'creation_ambiguous');intent.container={id:selected.id,createdAt:selected.createdAt};
    const sandbox=client.connect(selected);owned.push(sandbox);await saved();return sandbox;
  };
  const timer=setTimeout(()=>{report.deadlineExceeded=true;for(const sandbox of owned)sandbox.kill().catch(()=>{});},600_000);
  try{
    source=await create({catalogId:'node',size:'small'});
    await source.files.write('/workspace/persistence.bin',new Uint8Array([0,255,128,10]));
    const setup=await source.commands.run('mkdir -p /workspace/nested; printf preserved > /workspace/nested/marker; chmod 640 /workspace/nested/marker; touch -d @1700000000 /workspace/nested/marker; ln -s nested/marker /workspace/marker-link',{timeoutMs:15000});check(setup.exitCode===0,'fixture_failed');
    const process=await source.commands.start(['sleep','300'],{timeoutMs:300_000});report.processId=process.id;
    report.saveKey=randomUUID();report.saveBody={id:source.id,createdAt:source.createdAt,name:'Persistence qualification',stop:true};await saved();
    workspace=await client.request('/workspaces',{method:'POST',body:report.saveBody,headers:{'Idempotency-Key':report.saveKey}});report.workspaceId=workspace.id;await saved();
    check(workspace.status==='ready'&&workspace.stopCompleted&&!JSON.stringify(workspace).includes('handle'),'save_failed');
    await expected(()=>secondary.workspaces.get(workspace.id),404);report.checks.crossAccount=true;
    const retry=await client.request('/workspaces',{method:'POST',body:report.saveBody,headers:{'Idempotency-Key':report.saveKey}});check(retry.id===workspace.id,'save_replay_failed');report.checks.saveReplay=true;
    await client.workspaces.update(workspace.id,{archived:true});await expected(()=>client.request('/containers',{method:'POST',body:{workspaceId:workspace.id},headers:{'Idempotency-Key':randomUUID()}}),409);
    await client.workspaces.update(workspace.id,{archived:false});report.checks.archive=true;
    restored=await create({workspaceId:workspace.id});check(restored.createdAt!==source.createdAt&&restored.workspaceId===workspace.id,'generation_failed');
    const bytes=await restored.files.read('/workspace/persistence.bin');check(Buffer.from(bytes).equals(Buffer.from([0,255,128,10])),'binary_failed');
    const verify=await restored.commands.run('test "$(cat /workspace/marker-link)" = preserved && test "$(readlink /workspace/marker-link)" = nested/marker && test "$(stat -c %a /workspace/nested/marker)" = 640 && test "$(stat -c %Y /workspace/nested/marker)" = 1700000000',{timeoutMs:15000});check(verify.exitCode===0,'metadata_failed');report.checks.filesystem=true;
    const processState=await client.request(restored.path(`/containers/executions/${report.processId}`)).catch(error=>{if(error.status===404)return {status:'absent'};throw error;});check(!['starting','running'].includes(processState.status),'process_resumed');report.checks.noProcessResume=true;
    await expected(()=>source.files.read('/workspace/persistence.bin'),409);report.checks.staleGeneration=true;
    const archive=await restored.exportWorkspace();await verifyArchive(archive);report.checks.export=true;
    await client.workspaces.delete(workspace.id);await expected(()=>client.request('/containers',{method:'POST',body:{workspaceId:workspace.id},headers:{'Idempotency-Key':randomUUID()}}),404);report.checks.deletedRestore=true;
  }catch(error){report.error=typeof error.code==='string'?error.code:/^[a-z_]+$/.test(error.message)?error.message:'verification_failed';}
  finally{
    clearTimeout(timer);for(const sandbox of owned)try{await sandbox.kill();}catch{report.cleanupError=true;}
    if(workspace)try{await client.workspaces.delete(workspace.id);}catch{report.cleanupError=true;}
    const after=await client.list();report.afterStarts=after.usage.starts;report.remaining=after.containers.map(({id,createdAt})=>({id,createdAt}));
    report.cleanup=!report.cleanupError&&!report.remaining.length&&report.generations.every(g=>g.container)?'completed':'reconcile_manually';
    report.ok=!report.error&&!report.deadlineExceeded&&report.cleanup==='completed'&&report.afterStarts-report.beforeStarts===2;report.finishedAt=new Date().toISOString();await saved();
  }return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    check(process.argv.length===4&&process.argv[2]==='--max-starts=2'&&process.argv[3].startsWith('--output='),'explicit_budget_required');
    const output=resolve(process.argv[3].slice(9));await mkdir(output,{mode:0o700});
    const env={...parseEnv(await readFile(new URL('../.env',import.meta.url),'utf8')),...process.env};
    const options={baseUrl:env.MAINBRELLA_API_URL};const client=new Mainbrella({...options,apiKey:env.MAINBRELLA_API_KEY}),secondary=new Mainbrella({...options,apiKey:env.MAINBRELLA_API_KEY2});
    const checkpoint=async report=>{const path=join(output,'workspaces.json');await writeFile(path+'.tmp',JSON.stringify(report,null,2)+'\n',{mode:0o600});await rename(path+'.tmp',path);};
    const verifyArchive=async bytes=>{const path=join(output,'workspace.tar.gz');await writeFile(path,bytes,{mode:0o600});const restored=execFileSync('tar',['-xzOf',path,'./persistence.bin']);check(restored.equals(Buffer.from([0,255,128,10])),'export_content_failed');};
    const report=await verifyWorkspaces(client,secondary,{checkpoint,verifyArchive});console.log(JSON.stringify({output,ok:report.ok,cleanup:report.cleanup,checks:report.checks}));if(!report.ok)process.exitCode=1;
  }catch{console.error('Workspace verification stopped. Inspect private recovery evidence before rerunning.');process.exitCode=1;}
}

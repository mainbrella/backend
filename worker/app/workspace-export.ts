import { authCorsHeaders, authJson } from './auth-core';
import { containerUser } from './container-auth';
import { runningContainer,containerError } from '../lib/container-service';
import { validContainerId } from '../../containers/container-account-core.js';
import { validGeneration } from '../../containers/workspace-contract.js';

export async function handleWorkspaceExportRequest(request:Request,env:Env):Promise<Response>{
  const cors=authCorsHeaders(request);if(cors===null)return authJson({error:'origin_not_allowed'},403,{});
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
  if(request.method!=='GET')return authJson({error:'method_not_allowed'},405,{...cors,allow:'GET, OPTIONS'});
  const url=new URL(request.url),id=url.searchParams.get('id'),createdAt=url.searchParams.get('createdAt');
  if(!id||!validContainerId(id)||!validGeneration(createdAt)||[...url.searchParams.keys()].some(k=>!['id','createdAt'].includes(k)||url.searchParams.getAll(k).length!==1))return authJson({error:'invalid_request'},400,cors);
  try{
    const user=await containerUser(env,request);if(!user)return authJson({error:'not_authenticated'},401,cors);
    const running=await runningContainer(env,user.id,id);if(!running.stub||running.container?.createdAt!==createdAt)return authJson({error:'container_not_running'},409,cors);
    const response=await running.stub.fetch(new Request('https://internal/workspaces/export-v1',{signal:request.signal,headers:{'x-exec-created-at':createdAt!,'x-exec-expires-at':String(Date.parse(running.container.expiresAt))}}));
    if(!response.ok){const data=await response.json();return authJson(data,response.status,cors);}
    return new Response(response.body,{status:200,headers:{...cors,'Content-Type':'application/gzip','Content-Disposition':'attachment; filename="workspace.tar.gz"','Cache-Control':'no-store'}});
  }catch(error){const failure=containerError(error,'workspace_export_unavailable');return authJson({error:failure.error},failure.status,cors);}
}

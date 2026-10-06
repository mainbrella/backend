import { authCorsHeaders, authJson } from './auth-core';
import { containerUser } from './container-auth';
import { resolveEntitlement } from '../lib/entitlements';
import { entitlementHeaders } from '../../containers/plan-policy.js';
import { validWorkspaceId } from '../../containers/workspace-contract.js';
import { readFileBytes } from '../../containers/file-contract.js';

export async function handleWorkspacesRequest(request: Request, env: Env): Promise<Response> {
  const cors=authCorsHeaders(request);
  if(cors===null)return authJson({error:'origin_not_allowed'},403,{});
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
  if(!['GET','POST','PATCH','DELETE'].includes(request.method))return authJson({error:'method_not_allowed'},405,{...cors,allow:'GET, POST, PATCH, DELETE, OPTIONS'});
  if(request.method!=='GET' && !request.headers.get('Origin') && !request.headers.has('Authorization'))return authJson({error:'origin_required'},403,cors);
  const url=new URL(request.url),match=/^\/workspaces(?:\/([^/]+))?$/.exec(url.pathname);
  if(!match || url.search || match[1]&&!validWorkspaceId(match[1]))return authJson({error:'invalid_request'},400,cors);
  if(request.method==='POST'&&match[1] || ['PATCH','DELETE'].includes(request.method)&&!match[1])return authJson({error:'invalid_request'},400,cors);
  try{
    const user=await containerUser(env,request);if(!user)return authJson({error:'not_authenticated'},401,cors);
    if(request.method==='POST'&&env.WORKSPACE_PERSISTENCE_ENABLED!=='true')return authJson({error:'persistence_unavailable'},503,cors);
    if(!env.CONTAINER_ACCOUNT)return authJson({error:'workspaces_unavailable'},503,cors);
    // Existing saved state remains readable/deletable during billing outages.
    const entitlement=request.method==='POST'?await resolveEntitlement(env,user.id):{plan:null,active:false,validUntil:null};
    let body:Uint8Array|undefined;
    if(['POST','PATCH'].includes(request.method)){
      try{body=await readFileBytes(request.body,2048,request.signal);}catch{return authJson({error:'request_too_large'},413,cors);}
    }
    const internal=new URL('https://internal/workspaces');if(match[1])internal.searchParams.set('workspaceId',match[1]);
    const response=await env.CONTAINER_ACCOUNT.get(env.CONTAINER_ACCOUNT.idFromName(`account:${user.id}`)).fetch(new Request(internal,{method:request.method,
      headers:{...entitlementHeaders(entitlement),'x-mainbrella-user':user.id,...(request.headers.has('Idempotency-Key')?{'Idempotency-Key':request.headers.get('Idempotency-Key')!}:{}),'Content-Type':'application/json'},
      ...(body?{body:new Uint8Array(body).buffer}:{}),}));
    const data=await response.json();return authJson(data,response.status,cors);
  }catch{return authJson({error:'workspaces_unavailable'},503,cors);}
}

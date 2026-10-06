import { readFileBytes } from './file-contract.js';
import { MAX_EXECUTIONS } from './command-contract.js';
import { startOperationProcess } from './process-supervisor.js';

export const MAX_WORKSPACE_EXPORT_BYTES=16*1024*1024;
const timeoutMs=60_000;
const script=`set -eu
archive=$(mktemp /tmp/mainbrella-export.XXXXXXXXXX)
trap 'rm -f -- "$archive"' EXIT HUP INT TERM
tar --one-file-system -czf "$archive" -C /workspace . || exit 45
[ "$(stat -c %s "$archive")" -le ${MAX_WORKSPACE_EXPORT_BYTES} ] || exit 44
cat -- "$archive"`;

// Portable backup of /workspace, bounded independently of single-file transfer.
export async function exportWorkspace(controller,request,active){
  if(request.method!=='GET')return controller.respond({error:'method_not_allowed'},405);
  const createdAt=request.headers.get('x-exec-created-at'),expiresAt=Number(request.headers.get('x-exec-expires-at'));
  const metadata=await controller.getTerminalMetadata(createdAt,expiresAt);
  if(!metadata)return controller.respond({error:'container_not_running'},409);
  if(active.size>=MAX_EXECUTIONS)return controller.respond({error:'execution_limit'},429);
  const abort=new AbortController();let process,exited=false,timer,reason;
  const stop=value=>{reason=value;if(!exited){abort.abort();try{process?.kill(9);}catch{}}};
  const session={close:()=>stop('container_not_running')},disconnect=()=>stop('workspace_export_unavailable');active.add(session);
  request.signal.addEventListener('abort',disconnect,{once:true});
  try{
    timer=setTimeout(()=>stop('workspace_export_unavailable'),Math.max(1,Math.min(timeoutMs,metadata.expiresAt-controller.now())));
    if(request.signal.aborted)disconnect();
    const starting=startOperationProcess(controller,createdAt,expiresAt,['bash','-lc',script],{stdout:'pipe',stderr:'pipe',signal:abort.signal},timeoutMs);
    void starting.then(value=>{if(reason)try{value.kill(9);}catch{}}).catch(()=>{});
    process=await starting;const exit=process.exitCode.then(code=>{exited=true;return code;});
    const [code,bytes]=await Promise.all([exit,readFileBytes(process.stdout,MAX_WORKSPACE_EXPORT_BYTES,abort.signal),readFileBytes(process.stderr,8192,abort.signal)]);
    if(code===44)return controller.respond({error:'workspace_export_too_large'},413);
    if(code!==0 || reason)throw new Error();
    return new Response(bytes,{headers:{'Content-Type':'application/gzip','Content-Disposition':'attachment; filename="workspace.tar.gz"','Cache-Control':'no-store'}});
  }catch{return controller.respond({error:reason==='container_not_running'?reason:'workspace_export_unavailable'},reason==='container_not_running'?409:503);}
  finally{clearTimeout(timer);request.signal.removeEventListener('abort',disconnect);active.delete(session);if(!exited){abort.abort();try{process?.kill(9);}catch{}}await process?.dispose?.();}
}

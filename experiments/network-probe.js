import { readFileBytes } from '../containers/file-contract.js';
export const NETWORK_PROBE_DEADLINE_MS = 120_000;
const CA_PATH = '/etc/cloudflare/certs/cloudflare-containers-ca.crt';
export function relayUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
      || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname)
      || /(?:^|\.)(localhost|local|internal)$/.test(url.hostname)) return null;
    return url;
  } catch { return null; }
}
// Fixed operator-owned relay, not a customer-selected URL or general proxy.
// The receiver contract is a small {authenticated:true,runId} acknowledgment.
export async function relayRequest(request, env, props, fetcher = fetch, now = Date.now()) {
  const target = relayUrl(env.NETWORK_PROBE_RELAY_URL), url = new URL(request.url);
  const denied = () => Response.json({ allowed: false }, { status: 403 });
  if (!target || !props || props.mode !== 'allow' || typeof props.runId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(props.runId)
    || !Number.isSafeInteger(props.expiresAt) || props.expiresAt <= now || props.expiresAt > now + NETWORK_PROBE_DEADLINE_MS
    || request.method !== 'GET' || url.origin !== target.origin || url.pathname !== target.pathname
    || url.searchParams.size !== 1 || url.searchParams.get('runId') !== props.runId || url.hash
    || typeof env.NETWORK_PROBE_RELAY_TOKEN !== 'string' || !/^[\x21-\x7e]{32,256}$/.test(env.NETWORK_PROBE_RELAY_TOKEN)) return denied();
  target.searchParams.set('runId', props.runId);
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(5000)]);
  try {
    const response = await fetcher(target, { method: 'GET', redirect: 'error', credentials: 'omit', signal,
      headers: { Authorization: `Bearer ${env.NETWORK_PROBE_RELAY_TOKEN}`, Accept: 'application/json' } });
    const bytes = await readFileBytes(response.body, 4096, signal);
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!response.ok || value?.authenticated !== true || value.runId !== props.runId) throw new Error('relay_failed');
    return Response.json({ allowed: true, authenticated: true, runId: props.runId });
  } catch { return Response.json({ allowed: false, error: 'relay_unavailable' }, { status: 502 }); }
}

async function guest(container, source) {
  const abort = new AbortController(); let process, exited = false, timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(new Error('probe_step_timeout')); }, 20_000); });
  try {
    const starting = container.exec(['node', '-e', source], { signal: abort.signal, env: { NODE_EXTRA_CA_CERTS: CA_PATH } });
    void starting.then(value => { if (abort.signal.aborted) { try { value.kill(9); } catch {} } }).catch(() => {});
    process = await Promise.race([starting, deadline]);
    void process.exitCode.then(() => { exited = true; }, () => {});
    const result = await Promise.race([process.output(), deadline]);
    if (result.exitCode !== 0) throw new Error('probe_step_failed');
    const value = typeof result.stdout === 'string' ? result.stdout : new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
    if (value.length > 4096) throw new Error('probe_step_failed');
    return JSON.parse(value);
  } finally { clearTimeout(timer); if (!exited) { abort.abort(); try { process?.kill(9); } catch {} } }
}

export async function probeNetwork(ctx, relayBinding, env, { enabled = false } = {}) {
  const relay = relayUrl(env.NETWORK_PROBE_RELAY_URL);
  if (enabled !== true || env.NETWORK_PROBE_ENABLED !== 'true' || !relay || !/^[\x21-\x7e]{32,256}$/.test(env.NETWORK_PROBE_RELAY_TOKEN ?? '')) throw new Error('network_probe_not_configured');
  if (ctx.container.running || await ctx.storage.get('networkProbeStarted')) throw new Error('probe_already_used');
  const image = ctx.container.images.terminal;
  if (!image || !ctx.container.interceptAllOutboundHttp || !ctx.container.interceptOutboundHttps) throw new Error('network_probe_unavailable');
  await ctx.storage.put('networkProbeStarted', true);
  const runId = crypto.randomUUID(), expiresAt = Date.now() + NETWORK_PROBE_DEADLINE_MS;
  const result = { ok: false, runId, imageDigest: image, startedAt: new Date().toISOString(), cleanup: 'pending', checks: {} };
  await ctx.storage.setAlarm(expiresAt);
  let phase = 'interception';
  try {
    const props = { runId, expiresAt, mode: 'allow' }, binding = relayBinding(props);
    await ctx.container.interceptAllOutboundHttp(binding);
    await ctx.container.interceptOutboundHttps('*', binding);
    phase = 'start';
    ctx.container.start({ image, instance: 'lite', entrypoint: ['sleep', 'infinity'], enableInternet: false });
    await ctx.container.setInactivityTimeout(NETWORK_PROBE_DEADLINE_MS);
    relay.searchParams.set('runId', runId);
    phase = 'allowed';
    const allowSource = `fetch(${JSON.stringify(relay.href)},{signal:AbortSignal.timeout(5000)}).then(async r=>{const b=await r.json();console.log(JSON.stringify({status:r.status,authenticated:b.authenticated===true,runId:b.runId===${JSON.stringify(runId)}}));}).catch(()=>{console.log(JSON.stringify({status:0,authenticated:false,runId:false}));});`;
    const allowed = await guest(ctx.container, allowSource);
    result.checks.authenticatedRelay = allowed.status === 200 && allowed.authenticated === true && allowed.runId === true;
    phase = 'denied';
    const denied = await guest(ctx.container, `const net=require('node:net'),dns=require('node:dns').promises; (async()=>{
      const http=await fetch('http://denied.invalid/',{signal:AbortSignal.timeout(3000)}).then(r=>r.status).catch(()=>0);
      const https=await fetch('https://denied.invalid/',{signal:AbortSignal.timeout(3000)}).then(r=>r.status).catch(()=>0);
      const ip=await new Promise(resolve=>{const s=net.connect({host:'1.1.1.1',port:8443}); const finish=v=>{s.destroy();resolve(v);};s.once('connect',()=>finish(false));s.once('error',()=>finish(true));s.setTimeout(3000,()=>finish(true));});
      const resolver=new dns.Resolver({timeout:1000,tries:1}); const txt=await resolver.resolveTxt(${JSON.stringify(runId + '.example.net')}).then(()=>false,()=>true);resolver.cancel();
      console.log(JSON.stringify({httpDenied:http===403,httpsDenied:https===403,directIpDenied:ip,dnsTxtDenied:txt}));})();`);
    for (const name of ['httpDenied', 'httpsDenied', 'directIpDenied', 'dnsTxtDenied']) result.checks[name] = denied[name] === true;
    phase = 'revocation';
    const revoked = relayBinding({ ...props, mode: 'deny' });
    await ctx.container.interceptAllOutboundHttp(revoked);
    await ctx.container.interceptOutboundHttps('*', revoked);
    const after = await guest(ctx.container, allowSource);
    result.checks.revocation = after.status === 403 && after.authenticated === false;
    result.ok = Object.values(result.checks).every(value => value === true);
    if (!result.ok) result.error = 'network_checks_failed';
  } catch { result.error = `${phase}_failed`; }
  finally {
    try { if (ctx.container.running) await ctx.container.destroy(); await ctx.storage.deleteAlarm(); result.cleanup = 'completed'; }
    catch { result.cleanup = 'failed'; result.ok = false; }
    result.finishedAt = new Date().toISOString(); await ctx.storage.put('networkProbeResult', result);
  }
  return result;
}

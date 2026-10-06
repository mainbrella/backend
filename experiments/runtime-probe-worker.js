import { DurableObject } from 'cloudflare:workers';
import { probeRuntime } from './runtime-probe.js';

// Private RPC-only experiment. No fetch route accepts user traffic.
export class RuntimeProbe extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.busy = false;
    ctx.blockConcurrencyWhile(async () => {
      if (ctx.container.running) await ctx.container.destroy('Runtime probe restarted');
    });
  }
  run(options) {
    if (this.busy) throw new Error('probe_already_used');
    this.busy = true;
    return probeRuntime(this.ctx, options).finally(() => { this.busy = false; });
  }
  async result() { return { result: await this.ctx.storage.get('probeResult') ?? null, running: this.ctx.container.running }; }
  async alarm() {
    if (this.ctx.container.running) await this.ctx.container.destroy('Runtime probe deadline');
    await this.ctx.storage.deleteAlarm();
  }
}
// Temporary operator ingress is usable only when a single run identity and
// secret are explicitly configured. The checked-in configuration stays private.
export default { async fetch(request, env, ctx) {
  const url = new URL(request.url);
  if (!env.PROBE_RUN_ID || url.pathname !== `/probe/${env.PROBE_RUN_ID}` || url.search) return new Response(null, { status: 404 });
  if (!/^[a-f0-9]{64}$/.test(env.PROBE_TOKEN ?? '') || request.headers.get('Authorization') !== `Bearer ${env.PROBE_TOKEN}`) return new Response(null, { status: 401 });
  const probe=env.RUNTIME_PROBE.get(env.RUNTIME_PROBE.idFromName(env.PROBE_RUN_ID));
  if(request.method==='GET') return Response.json(await probe.result(), {headers:{'Cache-Control':'no-store'}});
  if(request.method==='POST') {ctx.waitUntil(probe.run({instance:'lite',snapshot:true,workload:'files'}).catch(()=>{}));return new Response(null,{status:202});}
  return new Response(null,{status:405});
} };

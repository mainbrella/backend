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
  result() { return this.ctx.storage.get('probeResult'); }
  async alarm() {
    if (this.ctx.container.running) await this.ctx.container.destroy('Runtime probe deadline');
  }
}
export default { fetch() { return new Response(null, { status: 404 }); } };

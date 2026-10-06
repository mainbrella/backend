import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { probeNetwork, relayRequest } from './network-probe.js';
export class NetworkRelay extends WorkerEntrypoint {
  fetch(request) { return relayRequest(request, this.env, this.ctx.props); }
}
export class NetworkProbe extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env); this.busy = false;
    ctx.blockConcurrencyWhile(async () => { if (ctx.container.running) await ctx.container.destroy('Network probe restarted'); });
  }
  run(options) {
    if (this.busy) throw new Error('probe_already_used'); this.busy = true;
    return probeNetwork(this.ctx, props => this.ctx.exports.NetworkRelay({ props }), this.env, options).finally(() => { this.busy = false; });
  }
  result() { return this.ctx.storage.get('networkProbeResult'); }
  async alarm() { if (this.ctx.container.running) await this.ctx.container.destroy('Network probe deadline'); }
}
export default { fetch() { return new Response(null, { status: 404 }); } };

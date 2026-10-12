import { DurableObject } from 'cloudflare:workers';
import { readFileBytes } from '../containers/file-contract.js';
import { createSecurityInfrastructureApp } from './app/openapi';
import { handleSecurityRelay } from './app/security-relay';
import { infrastructureError, operatorAuthorized } from './lib/security-infrastructure';

export class EgressRelay extends DurableObject<Env> {
  private active = 0;
  private boot?: Promise<void>;
  private async start(): Promise<void> {
    const c = this.ctx.container;
    if (!c || !this.env.EGRESS_RELAY_TOKEN) throw new Error('relay_unconfigured');
    const fingerprint = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(this.env.EGRESS_RELAY_TOKEN)))].map(value => value.toString(16).padStart(2, '0')).join('');
    if (c.running && await this.ctx.storage.get('tokenFingerprint') !== fingerprint) await c.destroy('Relay credential changed');
    if (!c.running) {
      c.start({ image: c.images.relay, instance: 'lite', enableInternet: true,
        env: { EGRESS_RELAY_TOKEN: this.env.EGRESS_RELAY_TOKEN, EGRESS_RELAY_BIND: '0.0.0.0', EGRESS_RELAY_PORT: '8081' } });
      await c.setInactivityTimeout(60_000);
      await this.ctx.storage.put('tokenFingerprint', fingerprint);
    }
    // running is not readiness. Probe the local socket without forwarding a
    // credentialed upstream request during startup or retrying a submitted one.
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const response = await c.getTcpPort(8081).fetch('http://relay/ready');
        if (response.status === 403) return;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('relay_not_ready');
  }
  async fetch(request: Request): Promise<Response> {
    if (!await operatorAuthorized(request, this.env.EGRESS_RELAY_TOKEN)) return infrastructureError('egress_denied', 403);
    if (this.active >= 2) return infrastructureError('egress_busy', 503);
    this.active++;
    try {
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
      const bytes = await readFileBytes(request.body, 6 * 1024 * 1024, request.signal);
      this.boot ??= this.start().finally(() => { this.boot = undefined; });
      await this.boot;
      return await this.ctx.container!.getTcpPort(8081).fetch(new Request('http://relay/v1/egress', {
        method: 'POST', headers: { Authorization: request.headers.get('Authorization')!, 'Content-Type': 'application/json' },
        body: bytes, signal: AbortSignal.any([request.signal, AbortSignal.timeout(35_000)]),
      }));
    } catch { return infrastructureError('egress_unavailable', 503); }
    finally { this.active--; await this.ctx.storage.setAlarm(Date.now() + 60_000); }
  }
  async alarm(): Promise<void> {
    if (this.active) { await this.ctx.storage.setAlarm(Date.now() + 1000); return; }
    if (this.ctx.container?.running) await this.ctx.container.destroy('Relay idle');
  }
}
const app = createSecurityInfrastructureApp('relay', handleSecurityRelay);
export default { fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx) };

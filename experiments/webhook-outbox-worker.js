import { DurableObject } from 'cloudflare:workers';
import { OutboxProbe, outboxProbeRoute } from './webhook-outbox-probe.mjs';
export class WebhookOutboxProbe extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.probe = new OutboxProbe(ctx, env); }
  fetch(request) { return this.probe.fetch(request, request.headers.get('x-probe-run-id')); }
  alarm() { return this.probe.alarm(); }
}
export default { fetch: outboxProbeRoute };

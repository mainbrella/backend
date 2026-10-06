import { DurableObject } from 'cloudflare:workers';
import { QualificationReceiver, receiverRoute } from './webhook-receiver-core.mjs';

export class WebhookQualificationReceiver extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.receiver = new QualificationReceiver(ctx.storage, env); }
  fetch(request) { return this.ctx.blockConcurrencyWhile(() => this.receiver.fetch(request)); }
  alarm() { return this.ctx.blockConcurrencyWhile(() => this.receiver.alarm()); }
}
export default { fetch: receiverRoute };

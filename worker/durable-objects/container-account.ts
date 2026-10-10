import { resolveEntitlement } from '../lib/entitlements';
import { invoiceResourceUsage } from '../lib/usage-billing';
import { prepaidRecharge } from '../lib/prepaid-billing';
import { appendAccountingEvent } from '../lib/accounting-ledger';
import { acceptPreviewObservation } from '../lib/acquisition-sources';
import { DurableObject } from 'cloudflare:workers';
import { ContainerAccountController, machineName } from '../../containers/container-account-core.js';
import { PrivateServicesController } from '../../containers/private-services.js';

export class ContainerAccount extends DurableObject<Env> {
  private controller: ContainerAccountController;
  private privateServices: PrivateServicesController;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const machineFor = (userId: string, id: string) => {
      if (!env.USER_CONTAINER) throw new Error('missing_container_binding');
      return env.USER_CONTAINER.get(env.USER_CONTAINER.idFromName(machineName(userId, id)));
    };
    this.controller = new ContainerAccountController(ctx, machineFor, undefined, event => invoiceResourceUsage(env, event), userId => resolveEntitlement(env, userId), entry => prepaidRecharge(env, entry), event => appendAccountingEvent(env, event));
    this.privateServices = new PrivateServicesController(ctx, machineFor);
  }
  fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === '/acquisition/preview-observed') {
      const owner = request.headers.get('x-mainbrella-user') ?? '';
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(owner) || !this.env.CONTAINER_ACCOUNT
        || !this.ctx.id.equals(this.env.CONTAINER_ACCOUNT.idFromName(`account:${owner}`))) {
        return Promise.resolve(new Response(null, { status: 403 }));
      }
      return acceptPreviewObservation(request, this.env, owner);
    }
    if (request.headers.has('x-private-source-id')) return this.privateServices.route(request, request.headers.get('x-mainbrella-user') ?? '');
    if (new URL(request.url).pathname.startsWith('/private-services/')) return this.privateServices.fetch(request);
    return this.controller.fetch(request);
  }
  alarm(): Promise<void> { return this.controller.alarm(); }
}

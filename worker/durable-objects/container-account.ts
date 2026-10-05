import { DurableObject } from 'cloudflare:workers';
import { ContainerAccountController, machineName } from '../../containers/container-account-core.js';

export class ContainerAccount extends DurableObject<Env> {
  private controller: ContainerAccountController;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.controller = new ContainerAccountController(ctx, (userId, id) => {
      if (!env.USER_CONTAINER) throw new Error('missing_container_binding');
      return env.USER_CONTAINER.get(env.USER_CONTAINER.idFromName(machineName(userId, id)));
    });
  }
  fetch(request: Request): Promise<Response> { return this.controller.fetch(request); }
  alarm(): Promise<void> { return this.controller.alarm(); }
}

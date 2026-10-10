import { handleRequest } from "./app/router";
import { AppState } from "./durable-objects/app-state";
import { collectStatus } from './app/status';
import { handleApplicationGateway } from './preview-gateway';
import { reconcileAcquisitionBilling } from './lib/acquisition-billing';

export { AppState };
export { ContainerAccount } from "./durable-objects/container-account";
export { AccountActivity } from './durable-objects/account-activity';

export default {
  fetch(request, env, ctx) {
    if (env.LOCAL_DEV === 'true' && new URL(request.url).hostname.endsWith('.localhost')) {
      return handleApplicationGateway(request, env, ctx);
    }
    return handleRequest(request, env, ctx);
  },
  scheduled(_event, env, ctx) {
    ctx.waitUntil(collectStatus(env).catch(() => { console.error('status_collection_failed'); }));
    if (env.ACQUISITION_ENABLED === 'true') {
      ctx.waitUntil(reconcileAcquisitionBilling(env).then(result => {
        if (result.errors.length) console.error('acquisition_billing_projection_incomplete');
      }).catch(() => { console.error('acquisition_billing_projection_failed'); }));
    }
  },
} satisfies ExportedHandler<Env>;

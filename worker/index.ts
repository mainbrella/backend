import { handleRequest } from "./app/router";
import { AppState } from "./durable-objects/app-state";
import { collectStatus } from './app/status';
import { handlePreviewGateway } from './preview-gateway';

export { AppState };
export { ContainerAccount } from "./durable-objects/container-account";
export { AccountActivity } from './durable-objects/account-activity';

export default {
  fetch(request, env, ctx) {
    if (env.LOCAL_DEV === 'true' && new URL(request.url).hostname.endsWith('.localhost')) {
      return handlePreviewGateway(request, env);
    }
    return handleRequest(request, env, ctx);
  },
  scheduled(_event, env, ctx) {
    ctx.waitUntil(collectStatus(env).catch(() => { console.error('status_collection_failed'); }));
  },
} satisfies ExportedHandler<Env>;

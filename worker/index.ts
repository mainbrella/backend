import { notifyStorageRetention } from './lib/r2-retention';
import { checkStorageHealth } from './lib/r2-health';
import { runStorageBilling } from './lib/r2-billing';
import { inventoryStoragePage, cleanupStorageOrphans, expireUnfundedStorage } from './lib/r2-maintenance';
import { handleRequest } from "./app/router";
import { AppState } from "./durable-objects/app-state";
import { collectStatus } from './app/status';
import { handleApplicationGateway } from './preview-gateway';
import { reconcileAcquisitionBilling } from './lib/acquisition-billing';
import { cleanupDeletedBuildGit } from './lib/build-git';
import { reconcileBuildTurns } from './app/build';

export { AppState };
export { ContainerAccount } from "./durable-objects/container-account";
export { AccountActivity } from './durable-objects/account-activity';
export { BuildWorkflow } from './workflows/build';

export default {
  fetch(request, env, ctx) {
    if (env.LOCAL_DEV === 'true' && new URL(request.url).hostname.endsWith('.localhost')) {
      return handleApplicationGateway(request, env, ctx);
    }
    return handleRequest(request, env, ctx);
  },
  scheduled(_event, env, ctx) {
    ctx.waitUntil((async () => {
      await inventoryStoragePage(env);
      await runStorageBilling(env);
      await notifyStorageRetention(env);
      await expireUnfundedStorage(env);
      await cleanupDeletedBuildGit(env);
      await cleanupStorageOrphans(env);
    })().catch(() => { console.error('storage_reconciliation_failed'); }));
    ctx.waitUntil(checkStorageHealth(env).catch(() => { console.error('storage_health_check_failed'); }));
    ctx.waitUntil(reconcileBuildTurns(env).catch(() => { console.error('build_reconciliation_failed'); }));
    ctx.waitUntil(collectStatus(env).catch(() => { console.error('status_collection_failed'); }));
    if (env.ACQUISITION_ENABLED === 'true') {
      ctx.waitUntil(reconcileAcquisitionBilling(env).then(result => {
        if (result.errors.length) console.error('acquisition_billing_projection_incomplete');
      }).catch(() => { console.error('acquisition_billing_projection_failed'); }));
    }
  },
} satisfies ExportedHandler<Env>;

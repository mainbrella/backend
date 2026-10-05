import { handleRequest } from "./app/router";
import { AppState } from "./durable-objects/app-state";
import { collectStatus } from './app/status';

export { AppState };
export { ContainerAccount } from "./durable-objects/container-account";

export default {
  fetch: handleRequest,
  scheduled(_event, env, ctx) {
    ctx.waitUntil(collectStatus(env).catch(() => { console.error('status_collection_failed'); }));
  },
} satisfies ExportedHandler<Env>;

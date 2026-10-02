import { handleRequest } from "./app/router";
import { AppState } from "./durable-objects/app-state";
import { processHerdPushEvents } from "./app/herd-push";

export { AppState };

export default {
  fetch: handleRequest,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(processHerdPushEvents(env));
  },
} satisfies ExportedHandler<Env>;

import { handleRequest } from "./app/router";
import { AppState } from "./durable-objects/app-state";

export { AppState };
export { ContainerAccount } from "./durable-objects/container-account";

export default {
  fetch: handleRequest,
} satisfies ExportedHandler<Env>;

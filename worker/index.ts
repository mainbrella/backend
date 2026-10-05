import { handleRequest } from "./app/router";
import { AppState } from "./durable-objects/app-state";

export { AppState };

export default {
  fetch: handleRequest,
} satisfies ExportedHandler<Env>;

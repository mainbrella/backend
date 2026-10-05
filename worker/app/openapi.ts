import { fromHono } from "chanfana";
import { Hono } from "hono";
import { registerAPIKeyRoutes } from "./openapi-api-keys";
import { registerAuthRoutes } from "./openapi-auth";
import { registerContainerRoutes } from "./openapi-containers";
import { registerCommandRoutes } from "./openapi-commands";
import { registerFileRoutes } from "./openapi-files";
import { registerCapabilityRoutes } from './openapi-capabilities';
import { registerExecutionRoutes } from './openapi-executions';
import { registerPreviewRoutes } from './openapi-previews';
import { registerStatusRoutes } from './openapi-status';
import { registerImageRoutes } from "./openapi-images";
import { registerSubscriptionRoutes } from "./openapi-subscription";
import { registerOperationsRoutes } from "./openapi-operations";
import { forward, type LegacyHandler } from "./openapi-shared";

export function createOpenAPIApp(handler: LegacyHandler) {
  const app = new Hono<{ Bindings: Env }>();
  const api = fromHono(app, {
    docs_url: "/docs", redoc_url: "/redocs", openapi_url: "/openapi.json",
    schema: {
      openapi: "3.1.0",
      info: { title: "Mainbrella API", version: "1.0.0", description: "Account, billing, container, image build, and WebSocket API." },
      servers: [{ url: "https://api.mainbrella.com" }, { url: "http://localhost:8787", description: "Local development" }],
      tags: ["Operations", "Authentication", "API Keys", "Subscriptions", "Containers", "Images", "Internal", "Admin"].map(name => ({ name })),
    },
  });
  const securitySchemes = {
    cookieAuth: { type: "apiKey", in: "cookie", name: "mainbrella_session" },
    sessionBearer: { type: "http", scheme: "bearer", description: "Browser session value; container and image automation only." },
    apiKeyBearer: { type: "http", scheme: "bearer", description: "API key (mb_ prefix); container, image and SSH automation only. Create at mainbrella.com/api-keys/." },
    nativeBearer: { type: "http", scheme: "bearer", description: "Native app access token; native auth endpoints only." },
    sshGateway: { type: "http", scheme: "bearer", description: "Trusted SSH gateway secret." },
    imageBuild: { type: "http", scheme: "bearer", description: "Trusted image build service secret." },
    stripeSignature: { type: "apiKey", in: "header", name: "Stripe-Signature" },
    monitoring: { type: 'http', scheme: 'bearer', description: 'Dedicated MONITORING_SECRET; operational observations and incidents only.' },
  } as const;
  for (const [name, scheme] of Object.entries(securitySchemes)) {
    api.registry.registerComponent("securitySchemes", name, scheme);
  }
  registerOperationsRoutes(api, handler);
  registerCapabilityRoutes(api, handler);
  registerExecutionRoutes(api, handler);
  registerPreviewRoutes(api, handler);
  registerStatusRoutes(api, handler);
  registerAuthRoutes(api, handler);
  registerAPIKeyRoutes(api, handler);
  registerSubscriptionRoutes(api, handler);
  registerContainerRoutes(api, handler);
  registerCommandRoutes(api, handler);
  registerFileRoutes(api, handler);
  registerImageRoutes(api, handler);
  app.all("*", context => forward(context, handler));
  return app;
}

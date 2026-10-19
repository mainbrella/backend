import { registerBuildRoutes, registerGithubBuildRoutes, registerProjectGithubRoutes } from '../vibe-openapi.ts';
import { registerStorageBillingRoutes } from './openapi-storage-billing';
import { registerDomainRoutes } from './openapi-domains';
import { registerRepoLaunchRoutes } from "./openapi-repo-launches";
import { registerGithubImportRoutes } from './openapi-github-import';
import { fromHono } from "chanfana";
import { Hono } from "hono";
import { registerAPIKeyRoutes } from "./openapi-api-keys";
import { registerProjectRoutes } from "./openapi-projects";
import { registerProjectHostingRoutes } from '../linux-openapi.ts';
import { registerAdminRoutes } from "./openapi-admin";
import { registerMarketingEmailRoutes } from "./openapi-marketing-email";
import { registerAuthRoutes } from "./openapi-auth";
import { registerContainerRoutes } from "../linux-openapi.ts";
import { registerContainerLifecycleRoutes } from '../linux-openapi.ts';
import { registerSecretRoutes } from '../linux-openapi.ts';
import { registerPoolRoutes } from '../linux-openapi.ts';
import { registerCommandRoutes } from "../linux-openapi.ts";
import { registerFileRoutes } from "../linux-openapi.ts";
import { registerFilesystemRoutes } from '../linux-openapi.ts';
import { registerCapabilityRoutes } from '../linux-openapi.ts';
import { registerActivityRoutes } from '../linux-openapi.ts';
import { registerExecutionRoutes } from '../linux-openapi.ts';
import { registerCodeContextRoutes } from '../linux-openapi.ts';
import { registerPreviewRoutes } from '../linux-openapi.ts';
import { registerStatusRoutes } from './openapi-status';
import { registerObservationRoutes } from '../linux-openapi.ts';
import { registerTelemetryRoutes } from '../linux-openapi.ts';
import { registerWebhookRoutes } from '../linux-openapi.ts';
import { registerWorkspaceRoutes } from '../linux-openapi.ts';
import { registerImageRoutes } from "../linux-openapi.ts";
import { registerSubscriptionRoutes } from "./openapi-subscription";
import { registerPrepaidBillingRoutes } from './openapi-prepaid-billing';
import { registerAppleIAPRoutes } from './openapi-apple-iap';
import { registerAccountingRoutes } from './openapi-accounting';
import { registerOperationsRoutes } from "./openapi-operations";
import { registerPrivateServiceRoutes } from '../linux-openapi.ts';
import { registerAcquisitionRoutes } from './openapi-acquisition';
import { forward, type LegacyHandler } from "./openapi-shared";
import { registerSecurityInfrastructureRoutes } from './openapi-security-infrastructure';
import { registerVoiceRoutes, registerVoiceTelnyxRoutes, registerVoiceNumberSearchRoutes } from '../voice-openapi.ts';
import { registerBffRoutes } from '../bff/openapi.ts';
import { isStaging, publicApiOrigin, publicWebOrigin } from '../lib/deployment-environment';

// Independent service documents keep infrastructure routes off the customer API.
export function createSecurityInfrastructureApp(kind: 'relay' | 'ack', handler: LegacyHandler) {
  const app = new Hono<{ Bindings: Env }>();
  const api = fromHono(app, { docs_url: null, redoc_url: null, openapi_url: '/openapi.json', schema: {
    openapi: '3.1.0', info: { title: `MainBrella security ${kind}`, version: '1.0.0' },
  } });
  api.registry.registerComponent('securitySchemes', 'operatorBearer', { type: 'http', scheme: 'bearer', description: 'Dedicated operator token; customer credentials are not accepted.' });
  api.registry.registerComponent('securitySchemes', 'upstreamBearer', { type: 'http', scheme: 'bearer', description: 'Disposable scoped token used only by the test acknowledgment upstream.' });
  registerSecurityInfrastructureRoutes(api, kind, handler);
  app.all('*', context => forward(context, handler));
  return app;
}

export function createOpenAPIApp(handler: LegacyHandler) {
  const app = new Hono<{ Bindings: Env }>();
  // Chanfana owns the static document. Rewrite only the response for a staging
  // request so production's generated schema and cached registry stay intact.
  app.use('/openapi.json', async (context, next) => {
    await next();
    if (context.req.method !== 'GET' || !isStaging(context.env) || !context.res.ok) return;
    const schema = await context.res.json() as {
      servers: { url: string }[];
      components: { securitySchemes: {
        cookieAuth: { name: string };
        apiKeyBearer: { description: string };
      } };
    };
    schema.servers = [{ url: publicApiOrigin(context.env) }];
    schema.components.securitySchemes.cookieAuth.name = 'mainbrella_session_stg';
    schema.components.securitySchemes.apiKeyBearer.description = schema.components.securitySchemes.apiKeyBearer.description
      .replace('mainbrella.com/api-keys/', `${new URL(publicWebOrigin(context.env)).host}/api-keys/`);
    context.res = new Response(JSON.stringify(schema), { status: context.res.status, headers: context.res.headers });
  });
  const api = fromHono(app, {
    docs_url: "/docs", redoc_url: "/redocs", openapi_url: "/openapi.json",
    schema: {
      openapi: "3.1.0",
      info: { title: "Mainbrella API", version: "1.0.0", description: "Account, billing, container, image build, and WebSocket API. Admin and marketing endpoints retain this origin and are forwarded to independently deployed Workers." },
      servers: [{ url: "https://api.mainbrella.com" }, { url: "http://localhost:8787", description: "Local development" }],
      tags: ["Operations", "Authentication", "API Keys", "Projects", "Domains", "Subscriptions", "Billing", "Containers", "Private Services", "Secrets", "Images", "Internal", "Admin", "Marketing", "Acquisition", "Build", "Voice", "BFF"].map(name => ({ name })),
    },
  });
  const securitySchemes = {
    cookieAuth: { type: "apiKey", in: "cookie", name: "mainbrella_session" },
    sessionBearer: { type: "http", scheme: "bearer", description: "Browser session value; container and image automation only." },
    apiKeyBearer: { type: "http", scheme: "bearer", description: "Account API key (mb_ prefix); account identity, container, image, SSH and BFF owner automation. Create at mainbrella.com/api-keys/. Scoped BFF browser keys do not grant account access." },
    nativeBearer: { type: "http", scheme: "bearer", description: "Native app access token; native auth endpoints only." },
    sshGateway: { type: "http", scheme: "bearer", description: "Trusted SSH gateway secret." },
    imageBuild: { type: "http", scheme: "bearer", description: "Trusted image build service secret." },
    stripeSignature: { type: "apiKey", in: "header", name: "Stripe-Signature" },
    monitoring: { type: 'http', scheme: 'bearer', description: 'Dedicated MONITORING_SECRET; operational observations and incidents only.' },
    twilioSignature: { type: 'apiKey', in: 'header', name: 'X-Twilio-Signature', description: 'Twilio request signature; validated against the configured Twilio auth token.' },
    telnyxSignature: { type: 'apiKey', in: 'header', name: 'telnyx-signature-ed25519', description: 'Ed25519 signature verified with TELNYX_PUBLIC_KEY and a fresh telnyx-timestamp header.' },
  } as const;
  for (const [name, scheme] of Object.entries(securitySchemes)) {
    api.registry.registerComponent("securitySchemes", name, scheme);
  }
  registerRepoLaunchRoutes(api, handler);
  registerGithubImportRoutes(api, handler);
  registerGithubBuildRoutes(api, handler);
  registerProjectGithubRoutes(api, handler);
  registerBuildRoutes(api, handler);
  registerVoiceRoutes(api, handler);
  registerVoiceTelnyxRoutes(api, handler);
  registerVoiceNumberSearchRoutes(api, handler);
  registerBffRoutes(api, handler);
  registerAcquisitionRoutes(api, handler);
  registerOperationsRoutes(api, handler);
  registerAdminRoutes(api, handler);
  registerMarketingEmailRoutes(api, handler);
  registerAccountingRoutes(api, handler);
  registerCapabilityRoutes(api, handler);
  registerActivityRoutes(api, handler);
  registerExecutionRoutes(api, handler);
  registerCodeContextRoutes(api, handler);
  registerPreviewRoutes(api, handler);
  registerPrivateServiceRoutes(api, handler);
  registerStatusRoutes(api, handler);
  registerObservationRoutes(api, handler);
  registerTelemetryRoutes(api, handler);
  registerWebhookRoutes(api, handler);
  registerWorkspaceRoutes(api, handler);
  registerAuthRoutes(api, handler);
  registerAPIKeyRoutes(api, handler);
  registerProjectRoutes(api, handler);
  registerProjectHostingRoutes(api, handler);
  registerDomainRoutes(api, handler);
  registerSubscriptionRoutes(api, handler);
  registerPrepaidBillingRoutes(api, handler);
  registerAppleIAPRoutes(api, handler);
  registerStorageBillingRoutes(api, handler);
  registerContainerRoutes(api, handler);
  registerContainerLifecycleRoutes(api, handler);
  registerSecretRoutes(api, handler);
  registerPoolRoutes(api, handler);
  registerCommandRoutes(api, handler);
  registerFileRoutes(api, handler);
  registerFilesystemRoutes(api, handler);
  registerImageRoutes(api, handler);
  app.all("*", context => forward(context, handler));
  return app;
}

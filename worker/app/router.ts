import { handleVoiceRequest } from './voice';
import { handleStorageBillingRequest } from './storage-billing';
import { handleDomainsRequest } from './domains';
import { handleRepoLaunchRequest } from "./repo-launches";
import { handleGithubImportRequest } from './github-import';
import { handleGithubBuildRequest } from './github-build';
import { handleProjectGithubRequest } from './project-github';
import { handleAPIKeysRequest } from "./api-keys";
import { handleProjectsRequest } from "./projects";
import { handleProjectEndpointRequest, handleProjectDomainsRequest } from './project-hosting';
import { createOpenAPIApp } from "./openapi";
import { syncAccountEntitlement } from "../lib/container-service";
import { jsonResponse } from "../shared/http";
import { handleAuthRequest } from "./auth";
import { handleSubscriptionRequest } from "./subscription";
import { handlePrepaidBillingRequest } from './prepaid-billing';
import { handleAppleIAPRequest } from './apple-iap';
import { forwardServiceRequest } from "../shared/service-proxy";
import { serviceForPath } from "../shared/service-routing";
import { handleContainersRequest } from "./containers";
import { handleContainerLifecycleRequest } from './container-lifecycle';
import { handleContainerStartupRequest } from './container-startup';
import { handleSecretsRequest } from './secrets';
import { handlePoolsRequest } from './pools';
import { handleSSHRequest } from "./ssh";
import { handleImagesRequest, handleImageBuildRequest } from "./images";
import { handleTerminalRequest } from "./terminal";
import { handleCommandRequest } from "./commands";
import { handleFileRequest } from "./files";
import { handleFilesystemRequest } from './filesystem';
import { handleCapabilitiesRequest } from './capabilities';
import { handleExecutionRequest } from './executions';
import { handleCodeContextRequest } from './code-contexts';
import { handlePreviewRequest } from './previews';
import { handleStatusRequest } from './status';
import { handleObservationRequest } from './observations';
import { handleTelemetryRequest } from './telemetry';
import { handleWebhookRequest } from './webhooks';
import { handleActivityRequest } from './activity';
import { handleWorkspacesRequest } from './workspaces';
import { handleWorkspaceExportRequest } from './workspace-export';
import { handlePrivateServicesRequest } from './private-services';
import { handleAcquisitionRequest } from './acquisition';
import { handleBuildRequest } from './build';

async function handleLegacyRequest(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/voice/')) return handleVoiceRequest(request, env, ctx);
  if (url.pathname === '/pools' || url.pathname.startsWith('/pools/')) return handlePoolsRequest(request, env);
  if (url.pathname === '/secrets' || url.pathname.startsWith('/secrets/')) return handleSecretsRequest(request, env);
  if (url.pathname === '/domains' || url.pathname.startsWith('/domains/')) return handleDomainsRequest(request, env);
  const service = serviceForPath(url.pathname);
  if (service === "admin") {
    return forwardServiceRequest(request, env.ADMIN_API, "admin_unavailable");
  }
  if (service === "marketing") {
    return forwardServiceRequest(request, env.MARKETING_API, "marketing_unavailable");
  }
  if (url.pathname.startsWith('/github/import/')) return handleGithubImportRequest(request, env);
  if (url.pathname.startsWith('/github/build/')) return handleGithubBuildRequest(request, env);
  if (url.pathname === '/projects/github' || url.pathname === '/projects/github/storage') return handleProjectGithubRequest(request, env);
  if (url.pathname.startsWith('/build/')) return handleBuildRequest(request, env);
  if (url.pathname.startsWith('/acquisition/')) return handleAcquisitionRequest(request, env);
  if (url.pathname.startsWith('/billing/apple/')) return handleAppleIAPRequest(request, env);
  if (url.pathname === '/billing/storage') return handleStorageBillingRequest(request, env);
  if (url.pathname === '/billing' || url.pathname.startsWith('/billing/')) return handlePrepaidBillingRequest(request, env);
  if (url.pathname === '/repo-launches' || url.pathname.startsWith('/repo-launches/')) return handleRepoLaunchRequest(request, env, ctx);
  if (url.pathname.startsWith('/private-services/')) return handlePrivateServicesRequest(request, env);
  if(url.pathname==='/containers/export')return handleWorkspaceExportRequest(request,env);
  if (url.pathname === '/containers/startup') return handleContainerStartupRequest(request, env);
  if (['/containers/stop', '/containers/resume', '/containers/fork'].includes(url.pathname)) return handleContainerLifecycleRequest(request, env);
  if(url.pathname==='/workspaces' || url.pathname.startsWith('/workspaces/'))return handleWorkspacesRequest(request,env);

  if (url.pathname === '/capabilities') return handleCapabilitiesRequest(request, env);
  if (url.pathname === '/containers/activity') return handleActivityRequest(request, env);
  if (['/containers/telemetry/logs', '/containers/telemetry/metrics'].includes(url.pathname)) return handleTelemetryRequest(request, env);
  if (['/containers/events', '/containers/metrics'].includes(url.pathname)) return handleObservationRequest(request, env);
  if (url.pathname === '/containers/webhook' || url.pathname.startsWith('/containers/webhook/')) return handleWebhookRequest(request, env);
  if (url.pathname === '/containers/previews') return handlePreviewRequest(request, env);
  if (['/status', '/status/history', '/internal/status/observations', '/internal/status/incidents'].includes(url.pathname)) return handleStatusRequest(request, env);
  if (url.pathname === '/containers/executions' || url.pathname.startsWith('/containers/executions/')) return handleExecutionRequest(request, env);
  if (url.pathname === '/containers/code-contexts' || url.pathname.startsWith('/containers/code-contexts/')) return handleCodeContextRequest(request, env);

  if (url.pathname === "/api-keys" || url.pathname === "/api-keys/me") return handleAPIKeysRequest(request, env);
  if (url.pathname === "/projects") return handleProjectsRequest(request, env);
  if (url.pathname === '/projects/endpoint') return handleProjectEndpointRequest(request, env);
  if (url.pathname === '/projects/domains' || url.pathname === '/projects/domains/verify') return handleProjectDomainsRequest(request, env);

  if (url.pathname === "/images" || url.pathname.startsWith("/images/")) return handleImagesRequest(request, env);
  if (url.pathname.startsWith("/internal/image-builds/")) return handleImageBuildRequest(request, env);

  if (url.pathname === "/containers/terminal") return handleTerminalRequest(request, env);
  if (url.pathname === "/containers/exec") return handleCommandRequest(request, env);
  if (url.pathname === "/containers/files") return handleFileRequest(request, env);
  if (url.pathname.startsWith('/containers/files/')) return handleFilesystemRequest(request, env);

  if (url.pathname === "/containers/ssh" || url.pathname.startsWith("/ssh/")) {
    return handleSSHRequest(request, env);
  }

  if (url.pathname === "/containers" || url.pathname.startsWith("/containers/")) {
    return handleContainersRequest(request, env, ctx);
  }

  if (url.pathname === "/subscription" || url.pathname.startsWith("/subscription/")) {
    return handleSubscriptionRequest(request, env, (userId, entitlement) => syncAccountEntitlement(env, userId, entitlement));
  }

  if (url.pathname.startsWith("/auth/")) {
    return handleAuthRequest(request, env, ctx);
  }

  if (url.pathname === "/health") {
    return jsonResponse({ ok: true });
  }

  if (url.pathname === "/state") {
    return handleState(request, env);
  }

  return jsonResponse({ error: "not_found" }, 404);
}

async function handleState(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") {
    return jsonResponse({ error: "method_not_allowed" }, 405, {
      allow: "GET",
    });
  }

  if (!env.APP_STATE) {
    return jsonResponse({ error: "durable_object_unavailable" }, 503);
  }

  const state = env.APP_STATE.get(env.APP_STATE.idFromName("global"));
  return state.fetch(new Request("https://internal/state", request));
}

export const app = createOpenAPIApp(handleLegacyRequest);

export async function handleRequest(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  // Hono supplies automatic HEAD handling; retain the existing method policy.
  if (request.method === "HEAD") return handleLegacyRequest(request, env, ctx);
  return app.fetch(request, env, ctx);
}

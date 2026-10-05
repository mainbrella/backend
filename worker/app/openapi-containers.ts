import { z } from "zod";
import { containerSecurity, cookieSecurity, errors, jsonResponse, planSchema, register, requestBody, type LegacyHandler, type OpenAPIApi } from "./openapi-shared";

export const limitsSchema = z.object({ maxContainers: z.number(), maxStartsPerMonth: z.number(), maxSessionMs: z.number(), idleTimeoutMs: z.number() });
const status = z.object({ plan: planSchema.nullable(), active: z.boolean(), containers: z.array(z.object({
  id: z.string(), name: z.string(), instance: z.literal("lite"), status: z.enum(["starting", "running"]),
  createdAt: z.string(), expiresAt: z.string(), imageId: z.string().optional(), imageName: z.string().optional(), catalogId: z.string().optional(),
  imageDigest: z.string().optional().describe('Deployment-resolved immutable image reference for this generation; absent on older generations.'),
})), limits: limitsSchema, usage: z.object({ month: z.string(), starts: z.number() }), imageCatalog: z.array(z.object({ id: z.string(), name: z.string() })) }).openapi("ContainerStatus");
const selection = z.object({ id: z.string().optional(), createdAt: z.string().optional() });
const browserOrigin = z.object({ Origin: z.string().describe("Trusted browser origin; required for cookie mutations.").optional() });

export function registerContainerRoutes(api: OpenAPIApi, handler: LegacyHandler): void {
  register(api, "get", "/containers", {
    operationId: "getContainers", tags: ["Containers"], summary: "Get account containers, paid allowance, and usage", security: containerSecurity,
    request: { query: z.object({ id: z.string().optional() }) },
    responses: { 200: jsonResponse(status), ...errors(400, 401, 403, 503) },
  }, handler);
  register(api, "post", "/containers", {
    operationId: "startContainer", tags: ["Containers"], summary: "Reserve a start and boot a container", security: containerSecurity,
    description: "Requires paid access. Body is optional; imageId and catalogId are mutually exclusive. Optional Idempotency-Key (1–128 letters, digits, underscores or hyphens) resolves retries to one account-scoped reservation for 24 hours. Keyed responses include creation identity and current starting/running status. Changed image selection returns 409 idempotency_key_conflict; stopped/replaced reservations return 409 creation_no_longer_running. Unkeyed requests reserve a new start. Cookie requests require a trusted Origin.",
    request: { headers: browserOrigin.extend({ "Idempotency-Key": z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional() }), ...requestBody(z.object({ imageId: z.string().optional(), catalogId: z.string().optional() }), false) },
    responses: { 200: jsonResponse(status.extend({ creation: z.object({ id: z.string(), containerId: z.string(), createdAt: z.string(), status: z.enum(["starting", "running"]) }).optional() })), ...errors(400, 401, 402, 403, 404, 429, 503),
      409: jsonResponse(z.object({ error: z.string(), creation: z.object({ id: z.string(), containerId: z.string(), status: z.literal("stopped") }).optional() }), "Capacity, image selection, idempotency conflict, or original creation no longer running.") },
  }, handler);
  register(api, "delete", "/containers", {
    operationId: "stopContainer", tags: ["Containers"], summary: "Stop a selected account container", security: containerSecurity,
    description: "An ID is required when multiple containers exist. createdAt rejects stale actions. Cookie requests require a trusted Origin. Cleanup remains available during billing outages.",
    request: { query: selection, headers: browserOrigin }, responses: { 200: jsonResponse(status), ...errors(400, 401, 403, 409, 503) },
  }, handler);
  register(api, "post", "/containers/ssh", {
    operationId: "issueSSHAccess", tags: ["Containers"], summary: "Issue short-lived SSH access to a running container", security: containerSecurity,
    description: "Returns a secret-bearing command. Cookie requests require a trusted Origin. expiresAt is Unix milliseconds.",
    request: { headers: browserOrigin, ...requestBody(z.object({ id: z.string(), createdAt: z.string().optional() }), false) },
    responses: { 200: jsonResponse(z.object({ command: z.string(), expiresAt: z.number(), hostname: z.string() })), ...errors(400, 401, 403, 409, 429, 503) },
  }, handler);
  register(api, "get", "/containers/terminal", {
    operationId: "connectBrowserTerminal", tags: ["Containers"], summary: "Upgrade to a browser terminal WebSocket", security: cookieSecurity,
    request: { query: z.object({ id: z.string().optional(), createdAt: z.string(), cols: z.number().int().optional(), rows: z.number().int().optional() }),
      headers: z.object({ Origin: z.string(), Upgrade: z.literal("websocket") }) },
    responses: { 101: { description: "Terminal WebSocket established." }, ...errors(400, 401, 403, 409, 426, 429, 503) },
  }, handler);
  register(api, "post", "/ssh/validate", {
    operationId: "validateSSHAccess", tags: ["Internal"], summary: "Validate SSH access for the trusted gateway", security: [{ sshGateway: [] }],
    request: requestBody(z.object({ token: z.string() })), responses: { 200: jsonResponse(z.object({ expiresAt: z.number() })), ...errors(401, 409, 503) },
  }, handler);
  register(api, "get", "/ssh/connect", {
    operationId: "connectSSHGateway", tags: ["Internal"], summary: "Upgrade the trusted SSH gateway connection", security: [{ sshGateway: [] }],
    request: { headers: z.object({ "x-mainbrella-ssh-token": z.string(), Upgrade: z.literal("websocket") }) },
    responses: { 101: { description: "SSH WebSocket established; query parameters are not accepted." }, ...errors(400, 401, 409, 429, 503) },
  }, handler);
}

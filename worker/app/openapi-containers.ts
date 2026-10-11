import { z } from "zod";
import { usageBillingSchema } from "./openapi-usage-billing";
import { containerSecurity, cookieSecurity, errors, jsonResponse, planSchema, register, requestBody, type LegacyHandler, type OpenAPIApi } from "./openapi-shared";

export const networkPolicySchema = z.object({ allow: z.array(z.string().min(1).max(253)).max(64), deny: z.array(z.string().min(1).max(253)).max(64).optional() }).strict().describe('HTTP/HTTPS egress on ports 80/443. Exact domains, *.domain, IPv4/IPv6 CIDR or *; deny wins. Hostname DNS lookup requires a matching domain allow rule; CIDR-only grants apply to literal IP requests. All resolved addresses must be public and allowed. Other protocols/ports and redirects are denied.');
const secretBindingsSchema = z.array(z.string().regex(/^sec_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/)).max(16);
export const limitsSchema = z.object({ maxComputeUnitHours: z.number().nullable(), maxConcurrentComputeUnits: z.number(), maxContainers: z.number(), maxStartsPerMonth: z.number(), maxSessionMs: z.number(), idleTimeoutMs: z.number() });
export const sizeSchema = z.enum(['lite', 'small', 'medium', 'large', 'xl']);
export const machineSizeSchema = z.object({ id: sizeSchema, name: z.string(), instance: z.string(), cpuVcpu: z.number(), memoryMiB: z.number(), diskGB: z.number(), computeUnits: z.number() });
export const containerStatusSchema = z.object({ plan: planSchema.nullable(), active: z.boolean(), containers: z.array(z.object({
  id: z.string(), name: z.string(), size: sizeSchema, computeUnits: z.number(), instance: z.enum(['lite', 'standard-1', 'standard-2', 'standard-3', 'standard-4']), status: z.enum(["starting", "running", "stopped"]),
  lifecycle: z.enum(['ad_hoc', 'production']).optional(), stopReason: z.string().optional(), internet: z.boolean().optional().describe("Immutable outbound internet selection; true for legacy generations."), createdAt: z.string(), expiresAt: z.string(), imageId: z.string().optional(), imageName: z.string().optional(), catalogId: z.string().optional(),
  networkPolicy: networkPolicySchema.optional(), secretBindings: secretBindingsSchema.optional(),
  workspaceId: z.string().uuid().optional(), persistenceExpiresAt: z.number().int().optional().describe('Saved filesystem expiry in Unix milliseconds for a stopped machine.'), imageDigest: z.string().optional().describe('Deployment-resolved immutable image reference for this generation; absent on older generations.'),
})), billing: usageBillingSchema.nullable(), limits: limitsSchema, usage: z.object({ month: z.string(), starts: z.number(), computeUnitHours: z.number(), reservedComputeUnitHours: z.number(), availableComputeUnitHours: z.number(), concurrentComputeUnits: z.number() }), sizes: z.array(machineSizeSchema), imageCatalog: z.array(z.object({ id: z.string(), name: z.string() })) }).openapi("ContainerStatus");
const selection = z.object({ id: z.string().optional(), createdAt: z.string().optional() });
const status = containerStatusSchema;
const browserOrigin = z.object({ Origin: z.string().describe("Trusted browser origin; required for cookie mutations.").optional() });

export function registerContainerRoutes(api: OpenAPIApi, handler: LegacyHandler): void {
  register(api, "get", "/containers", {
    operationId: "getContainers", tags: ["Containers"], summary: "Get account containers, paid allowance, and usage", security: containerSecurity,
    request: { query: z.object({ id: z.string().optional() }) },
    responses: { 200: jsonResponse(status), ...errors(400, 401, 403, 503) },
  }, handler);
  register(api, "post", "/containers", {
    operationId: "startContainer", tags: ["Containers"], summary: "Reserve a start and boot a container", security: containerSecurity,
    description: "Requires paid access. lifecycle defaults to ad_hoc. production requires usage billing and a compatible production runtime; prepaid launch or fleet expansion also requires 24 hours of confirmed funding for the resulting fleet (402 insufficient_production_balance); uses renewable five-minute compute reservations, has no session or idle shutdown, and automatically recovers from runtime interruption using the same logical service identity and immutable image. Optional startupCommand (one line, at most 4096 characters) is supervised with restart backoff and runs from the image on every recovery; allowed only with production. Production cannot restore a saved workspace. Explicit DELETE removes desired state; a spending cap or loss of paid access stops compute while retaining desired service identity. Recovery resumes only with verified funding and available cap. Pending or failed payments grant no runtime. No persistent disk or HTTP readiness/uptime guarantee. Production failures return 503 production_unavailable; legacy plans return 402 production_requires_usage. Idempotency fingerprints include lifecycle and startupCommand. workspaceId restores an owned, unarchived saved filesystem workspace using its original image, size and internet policy; cannot combine with imageId/catalogId. Requires persistence.snapshots. Expired snapshots return 410, incompatible image versions return 409 before start reservation. A restore consumes a normal start and compute allowance. New generation invalidates old access; RAM and processes are not restored. No empty-image fallback. Optional name is a display label of 1–80 characters after trimming, without control characters; omitted names retain generated labels. Body is optional and limited to 64 KiB; size defaults to lite and accepts lite, small, medium, large, xl. Runtime is reserved against both confirmed prepaid funding and the account spending cap, or the monthly compute allowance for legacy plans; unused runtime is released on stop and is never billed. Prepaid balance carries forward; monthly consumption caps reset at the UTC month boundary and prepaid sessions can cross that boundary within their funds and cap. Legacy sessions end at that boundary. Usage cap exhaustion returns 429 spend_limit_reached; an unresolved invoice write returns 503 billing_reconciliation_required. imageId and catalogId are mutually exclusive. Optional Idempotency-Key (1–128 letters, digits, underscores or hyphens) resolves retries to one account-scoped reservation for 24 hours. Keyed responses include creation identity and current starting/running status. networkPolicy requires networking.egressPolicies and a qualified private runtime/relay, implies internet:false, and cannot combine with internet:true. secretBindings contains owned secret IDs, requires a networkPolicy and secrets.vault; values remain outside the guest. Policies and binding IDs are immutable per generation and part of the idempotency fingerprint. internet defaults to true. internet:false requires networking.internetControl and a compatible private runtime; otherwise fails closed with 503 network_policy_unavailable before reserving a start. Changed name, image, size or internet selection returns 409 idempotency_key_conflict; stopped/replaced reservations return 409 creation_no_longer_running. Unkeyed requests reserve a new start. Cookie requests require a trusted Origin.",
    request: { headers: browserOrigin.extend({ "Idempotency-Key": z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional() }), ...requestBody(z.object({ lifecycle: z.enum(['ad_hoc', 'production']).optional(), startupCommand: z.string().max(4096).regex(/^[^\u0000\r\n]*$/).optional(), name: z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f\u007f]+$/).optional(), imageId: z.string().optional(), catalogId: z.string().optional(), size: sizeSchema.optional(), internet: z.boolean().optional(), networkPolicy: networkPolicySchema.optional(), secretBindings: secretBindingsSchema.optional(), workspaceId: z.string().uuid().optional() }), false) },
    responses: { 200: jsonResponse(status.extend({ creation: z.object({ id: z.string(), containerId: z.string(), createdAt: z.string(), status: z.enum(["starting", "running", "stopped"]) }).optional() })), ...errors(400, 401, 402, 403, 404, 410, 413, 429, 503),
      409: jsonResponse(z.object({ error: z.string(), creation: z.object({ id: z.string(), containerId: z.string(), status: z.literal("stopped") }).optional() }), "Capacity, image selection, idempotency conflict, or original creation no longer running.") },
  }, handler);
  register(api, "delete", "/containers", {
    operationId: "stopContainer", tags: ["Containers"], summary: "Permanently delete a selected account container", security: containerSecurity,
    description: "Destructive deletion without saving the filesystem. Use POST /containers/stop for a resumable stop. Removes any suspended slot and production desired state. An ID is required when multiple containers exist. createdAt rejects stale actions. Cookie requests require a trusted Origin. Cleanup remains available during billing outages. The historical operation ID is retained for generated-client compatibility.",
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

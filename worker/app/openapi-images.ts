import { z } from "zod";
import { containerSecurity, errors, jsonResponse, register, requestBody, type LegacyHandler, type OpenAPIApi } from "./openapi-shared";

const image = z.object({ id: z.string(), name: z.string(), status: z.enum(["queued", "building", "publishing", "ready", "failed"]), createdAt: z.string(), updatedAt: z.string() }).openapi("Image");
const params = z.object({ id: z.string().uuid() });
const internalSecurity = [{ imageBuild: [] }];

export function registerImageRoutes(api: OpenAPIApi, handler: LegacyHandler): void {
  register(api, "get", "/images", {
    operationId: "listImages", tags: ["Images"], summary: "List account images and monthly build usage", security: containerSecurity,
    responses: { 200: jsonResponse(z.object({ images: image.array(), buildsEnabled: z.boolean(),
      limits: z.object({ maxBuildsPerMonth: z.number(), maxSavedImages: z.number(), maxContextBytes: z.number(), maxDockerfileBytes: z.number(), maxBuildSeconds: z.number() }),
      usage: z.object({ month: z.string(), builds: z.number() }) })), ...errors(401, 403, 503) },
  }, handler);
  register(api, "post", "/images", {
    operationId: "createImage", tags: ["Images"], summary: "Queue a custom image build", security: containerSecurity,
    description: "Cookie requests require a trusted Origin. Dockerfile must start with FROM mainbrella:base; one build stage. Optional gzip context is limited to 512 KiB, Dockerfile to 16 KiB.",
    request: { body: { required: true, content: { "multipart/form-data": { schema: z.object({
      name: z.string().min(1).max(80), dockerfile: z.string(), context: z.string().openapi({ format: "binary" }).optional(),
    }) } } } }, responses: { 202: jsonResponse(z.object({ image })), ...errors(400, 401, 403, 409, 413, 429, 503) },
  }, handler);
  register(api, "get", "/images/:id", {
    operationId: "getImage", tags: ["Images"], summary: "Get an owned image", security: containerSecurity,
    request: { params }, responses: { 200: jsonResponse(z.object({ image })), ...errors(401, 403, 404, 503) },
  }, handler);
  register(api, "delete", "/images/:id", {
    operationId: "deleteImage", tags: ["Images"], summary: "Delete an owned image and queue deployment reconciliation", security: containerSecurity,
    description: "Active builds cannot be deleted. Cookie requests require a trusted Origin.",
    request: { params }, responses: { 200: jsonResponse(z.object({ deleted: z.boolean() })), ...errors(401, 403, 404, 409, 503) },
  }, handler);
  register(api, "get", "/images/:id/logs", {
    operationId: "getImageLogs", tags: ["Images"], summary: "Get image build logs", security: containerSecurity,
    request: { params }, responses: { 200: jsonResponse(z.object({ logs: z.string(), status: z.string() })), ...errors(401, 403, 404, 503) },
  }, handler);
  register(api, "get", "/internal/image-builds/manifest", {
    operationId: "getImageManifest", tags: ["Internal"], summary: "Get deployable custom images", security: internalSecurity,
    responses: { 200: jsonResponse(z.object({ images: z.record(z.string(), z.object({ image: z.string() })) })), ...errors(401, 503) },
  }, handler);
  for (const method of ["post", "delete"] as const) {
    register(api, method, "/internal/image-builds/deployment-lock", {
      operationId: method === "post" ? "acquireImageDeploymentLock" : "releaseImageDeploymentLock", tags: ["Internal"],
      summary: method === "post" ? "Acquire the image deployment lease" : "Release the image deployment lease", security: internalSecurity,
      request: requestBody(z.object({ token: z.string().uuid() })),
      responses: { 200: jsonResponse(method === "post" ? z.object({ acquired: z.boolean() }) : z.object({ released: z.boolean() })), ...errors(400, 401, 409, 503) },
    }, handler);
  }
  register(api, "post", "/internal/image-builds/:id/source", {
    operationId: "claimImageBuildSource", tags: ["Internal"], summary: "Claim queued build source for a trusted runner", security: internalSecurity,
    request: { params }, responses: { 200: jsonResponse(z.object({ dockerfile: z.string(), contextBase64: z.string().nullable() })), ...errors(401, 404, 409, 503) },
  }, handler);
  register(api, "post", "/internal/image-builds/:id/status", {
    operationId: "updateImageBuildStatus", tags: ["Internal"], summary: "Report trusted image publication or build failure", security: internalSecurity,
    request: { params, ...requestBody(z.object({ status: z.enum(["failed", "publishing", "ready"]), image: z.string().optional(), logs: z.string().optional() })) },
    responses: { 200: jsonResponse(z.object({ updated: z.boolean() })), ...errors(400, 401, 404, 409, 503) },
  }, handler);
}

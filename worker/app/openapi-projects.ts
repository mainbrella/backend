import { z } from "zod";
import { cookieSecurity, errors, jsonResponse, register, requestBody, type LegacyHandler, type OpenAPIApi } from "./openapi-shared";

const domain = z.string().trim().max(253).nullable().openapi({ description: "Optional project domain; blank values are stored as null." });
const project = z.object({ id: z.string().uuid(), name: z.string(), domain: z.string().nullable(), created_at: z.string() });
export function registerProjectRoutes(api: OpenAPIApi, handler: LegacyHandler): void {
  register(api, "get", "/projects", {
    operationId: "listProjects", tags: ["Projects"], summary: "List your projects", security: cookieSecurity,
    description: "Requires a browser session. Returns only the signed-in user's projects, newest first.",
    responses: { 200: jsonResponse(z.object({ projects: z.array(project) })), ...errors(401, 403, 503) },
  }, handler);
  register(api, "post", "/projects", {
    operationId: "createProject", tags: ["Projects"], summary: "Create a named project", security: cookieSecurity,
    description: "Requires a trusted Origin and browser session. The project belongs to the signed-in user. Names are trimmed and may contain up to 80 characters. An optional domain is trimmed, may contain up to 253 characters, and blank or null values are stored as null.",
    request: requestBody(z.object({ name: z.string().trim().min(1).max(80), domain: domain.optional() })),
    responses: { 201: jsonResponse(z.object({ project })), ...errors(400, 401, 403, 503) },
  }, handler);
  register(api, "patch", "/projects", {
    operationId: "updateProject", tags: ["Projects"], summary: "Update a project", security: cookieSecurity,
    description: "Requires a trusted Origin and browser session. Updates only a project owned by the signed-in user; its ID and creation time are preserved. Names are required. An omitted domain is preserved; a supplied domain is trimmed, may contain up to 253 characters, and blank or null clears it.",
    request: {
      query: z.object({ id: z.string().uuid() }),
      ...requestBody(z.object({ name: z.string().trim().min(1).max(80), domain: domain.optional() })),
    },
    responses: { 200: jsonResponse(z.object({ project })), ...errors(400, 401, 403, 404, 503) },
  }, handler);
}

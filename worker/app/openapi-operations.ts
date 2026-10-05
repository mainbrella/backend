import { z } from "zod";
import { cookieSecurity, errors, jsonResponse, okSchema, register, type LegacyHandler, type OpenAPIApi } from "./openapi-shared";

export function registerOperationsRoutes(api: OpenAPIApi, handler: LegacyHandler): void {
  register(api, "get", "/health", {
    operationId: "getHealth", tags: ["Operations"], summary: "Check API health", responses: { 200: jsonResponse(okSchema) },
  }, handler);
  register(api, "get", "/state", {
    operationId: "getState", tags: ["Operations"], summary: "Increment and return the global durable visit counter",
    responses: { 200: jsonResponse(z.object({ visits: z.number() })), ...errors(503) },
  }, handler);
  register(api, "get", "/admin/tables", {
    operationId: "listAdminTables", tags: ["Admin"], summary: "List tables available to the administrator", security: cookieSecurity,
    responses: { 200: jsonResponse(z.object({ tables: z.array(z.object({ id: z.string(), label: z.string(), group: z.string(), columns: z.string().array() })) })), ...errors(401, 403, 503) },
  }, handler);
  register(api, "get", "/admin/tables/:table", {
    operationId: "getAdminTable", tags: ["Admin"], summary: "Search and page administrator table rows", security: cookieSecurity,
    request: { params: z.object({ table: z.string() }), query: z.object({ offset: z.number().int().min(0).max(1_000_000).optional(), q: z.string().max(100).optional() }) },
    responses: { 200: jsonResponse(z.object({ items: z.array(z.record(z.string(), z.unknown())), total: z.number(), offset: z.number(), limit: z.number() })), ...errors(400, 401, 403, 404, 503) },
  }, handler);
}

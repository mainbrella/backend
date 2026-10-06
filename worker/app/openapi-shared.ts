import { OpenAPIRoute, contentJson } from "chanfana";
import type { HonoOpenAPIRouterType, OpenAPIRouteSchema, ResponseConfig } from "chanfana";
import type { Context } from "hono";
import { z } from "zod";

export type LegacyHandler = (request: Request, env: Env, ctx?: ExecutionContext) => Promise<Response>;
export type OpenAPIApi = HonoOpenAPIRouterType<{ Bindings: Env }>;
export const cookieSecurity = [{ cookieAuth: [] }];
export const containerSecurity: NonNullable<OpenAPIRouteSchema["security"]> = [{ cookieAuth: [] }, { sessionBearer: [] }, { apiKeyBearer: [] }];
export const nativeSecurity = [{ nativeBearer: [] }];
export const planSchema = z.enum(["builder", "pro", "scale"]);
export const okSchema = z.object({ ok: z.boolean() });
export const userSchema = z.object({
  id: z.string(), email: z.string().nullable(), name: z.string(),
  created_at: z.string(), dob: z.string().nullable(),
}).openapi("PublicUser");

export function jsonResponse(schema: z.ZodType, description = "Successful response."): ResponseConfig {
  return { description, ...contentJson(schema) };
}
export function errors(...statuses: number[]): Record<string, ResponseConfig> {
  const descriptions: Record<number, string> = {
    400: "Invalid request.", 401: "Authentication required or credential invalid.",
    402: "Paid access required.", 403: "Origin or permission denied.", 404: "Not found.",
    405: "Method not allowed.", 409: "Conflicts with current state.", 413: "Request too large.",
    410: "Saved workspace has expired.",
    426: "WebSocket upgrade required.", 429: "Rate, quota, or connection limit exceeded.",
    500: "Internal error.", 502: "Provider request failed.", 503: "Service unavailable.",
  };
  return Object.fromEntries(statuses.map(status => [status, jsonResponse(
    z.object({ error: z.string(), provider: z.string().optional() }), descriptions[status],
  )]));
}
export const requestBody = (schema: z.ZodType, required = true) => ({
  body: { required, ...contentJson(schema) },
});

export function forward(context: Context<{ Bindings: Env }>, handler: LegacyHandler): Promise<Response> {
  let ctx: ExecutionContext | undefined;
  // Hono's getter throws when invoked outside a Worker (tests/schema export).
  try { ctx = context.executionCtx as ExecutionContext; } catch { /* No runtime context. */ }
  return handler(context.req.raw, context.env, ctx);
}

export function register(
  api: OpenAPIApi,
  method: "get" | "post" | "delete" | "patch" | "put",
  path: string,
  schema: OpenAPIRouteSchema,
  handler: LegacyHandler,
): void {
  class Endpoint extends OpenAPIRoute {
    schema = schema;
    async handle(context: Context<{ Bindings: Env }>): Promise<Response> {
      // Schemas describe the API. Existing handlers own validation, auth, CORS,
      // streaming/WebSocket responses, and background work.
      return forward(context, handler);
    }
  }
  api[method](path, Endpoint);
}

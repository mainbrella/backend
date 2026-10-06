import test from "node:test";
import assert from "node:assert/strict";
import { createOpenAPIApp } from "./openapi";
import { handleRequest } from "./router";

const endpointMethods: Record<string, string[]> = {
  '/workspaces': ['get','post'], '/workspaces/{workspaceId}': ['get','patch','delete'], '/containers/export': ['get'],
  '/capabilities': ['get'],
  '/containers/activity': ['get'],
  '/status': ['get'], '/status/history': ['get'],
  '/internal/status/observations': ['post'], '/internal/status/incidents': ['post'],
  '/containers/executions': ['get', 'post'],
  '/containers/executions/{executionId}/stdin': ['post', 'delete'],
  '/containers/executions/{executionId}/signal': ['post'],
  '/containers/executions/{executionId}/resize': ['post'],
  '/containers/previews': ['get', 'post', 'delete'],
  '/containers/events': ['get'], '/containers/metrics': ['get'],
  '/containers/webhook': ['get', 'put', 'delete'], '/containers/webhook/deliveries': ['get'], '/containers/webhook/retry': ['post'],
  '/containers/executions/{executionId}': ['get', 'delete'],
  '/containers/executions/{executionId}/events': ['get'],
  "/api-keys": ["get", "post", "delete"],
  "/health": ["get"], "/state": ["get"],
  "/auth/google": ["post"], "/auth/email": ["post"], "/auth/me": ["get"], "/auth/logout": ["post"],
  "/auth/app/google": ["post"], "/auth/app/email": ["post"], "/auth/app/apple": ["post"],
  "/auth/app/anonymous": ["post"], "/auth/app/me": ["get", "delete"],
  "/auth/app/refresh": ["post"], "/auth/app/logout": ["post"],
  "/subscription/config": ["get"], "/subscription": ["get"],
  "/subscription/trial": ["post"], "/subscription/checkout": ["post"], "/subscription/complete": ["post"], "/subscription/portal": ["post"],
  "/subscription/change": ["post"], "/subscription/cancel": ["post"], "/subscription/resume": ["post"],
  "/subscription/webhook": ["post"], "/containers": ["get", "post", "delete"],
  "/containers/ssh": ["post"], "/containers/terminal": ["get"],
  "/containers/exec": ["post"],
  "/containers/files": ["get", "put"],
  '/containers/files/list': ['get'], '/containers/files/stat': ['get'],
  '/containers/files/mkdir': ['post'], '/containers/files/remove': ['delete'],
  '/containers/files/move': ['post'], '/containers/files/chmod': ['patch'],
  "/ssh/validate": ["post"], "/ssh/connect": ["get"],
  "/images": ["get", "post"], "/images/{id}": ["get", "delete"], "/images/{id}/logs": ["get"],
  "/internal/image-builds/manifest": ["get"], "/internal/image-builds/deployment-lock": ["post", "delete"],
  "/internal/image-builds/{id}/source": ["post"], "/internal/image-builds/{id}/status": ["post"],
  "/admin/tables": ["get"], "/admin/tables/{table}": ["get"],
};

async function document() {
  const response = await handleRequest(new Request("https://api.mainbrella.com/openapi.json"), {} as Env);
  assert.equal(response.status, 200);
  return response.json() as Promise<any>;
}

test('filesystem schemas expose exact generation, bounded pagination, permissions and mutation semantics', async () => {
  const { paths } = await document();
  const list = paths['/containers/files/list'].get;
  assert.equal(list.operationId, 'listContainerDirectory');
  for (const name of ['id', 'createdAt', 'path']) assert.ok(list.parameters.some((p: any) => p.name === name && p.required));
  assert.equal(list.parameters.find((p: any) => p.name === 'limit').schema.maximum, 1000);
  assert.deepEqual(list.security, [{ cookieAuth: [] }, { sessionBearer: [] }, { apiKeyBearer: [] }]);
  assert.match(paths['/containers/files/move'].post.description, /no replacement/);
  assert.match(paths['/containers/files/remove'].delete.description, /partially complete/);
  assert.equal(paths['/containers/files/chmod'].patch.requestBody.content['application/json'].schema.properties.mode.pattern, '^0[0-7]{3}$');
  assert.ok(paths['/containers/files/stat'].get.parameters.some((p: any) => p.name === 'followSymlinks'));
});

test("OpenAPI 3.1 documents every current endpoint with unique operation IDs and valid security references", async () => {
  const schema = await document();
  assert.equal(schema.openapi, "3.1.0");
  assert.equal(schema.info.title, "Mainbrella API");
  assert.equal(schema.components.securitySchemes.cookieAuth.name, "mainbrella_session");
  assert.deepEqual(Object.keys(schema.paths).sort(), Object.keys(endpointMethods).sort());
  const ids = new Set<string>();
  for (const [path, methods] of Object.entries(endpointMethods)) {
    assert.deepEqual(Object.keys(schema.paths[path]).sort(), [...methods].sort(), path);
    for (const method of methods) {
      const operation = schema.paths[path][method];
      assert.ok(operation.summary, `${method} ${path}`);
      assert.ok(operation.operationId);
      assert.ok(!ids.has(operation.operationId), operation.operationId);
      ids.add(operation.operationId);
      assert.ok(Object.keys(operation.responses).length);
      for (const requirement of operation.security || []) {
        for (const name of Object.keys(requirement)) assert.ok(schema.components.securitySchemes[name], name);
      }
      for (const name of path.matchAll(/\{([^}]+)\}/g)) {
        assert.ok(operation.parameters.some((parameter: any) => parameter.in === "path" && parameter.name === name[1] && parameter.required));
      }
    }
  }
});

test("schema describes optional container bodies, multipart image source, and WebSocket upgrades", async () => {
  const { paths } = await document();
  assert.equal(paths["/containers"].post.requestBody.required, false);
  const key = paths["/containers"].post.parameters.find((parameter: any) => parameter.name === "Idempotency-Key");
  assert.equal(key.in, "header");
  assert.equal(key.required, false);
  assert.ok(key.schema.pattern);
  assert.match(paths["/containers"].post.description, /24 hours/);
  assert.ok(paths["/containers"].post.responses[200].content["application/json"].schema.allOf[1].properties.creation);
  assert.equal(paths["/images"].post.requestBody.required, true);
  const multipart = paths["/images"].post.requestBody.content["multipart/form-data"].schema;
  assert.equal(multipart.properties.context.format, "binary");
  assert.deepEqual(multipart.required, ["name", "dockerfile"]);
  assert.ok(paths["/containers/terminal"].get.responses[101]);
  assert.ok(paths["/ssh/connect"].get.responses[101]);
  assert.deepEqual(paths["/subscription/checkout"].post.security, [{ cookieAuth: [] }]);
  assert.deepEqual(paths["/containers"].post.security, [{ cookieAuth: [] }, { sessionBearer: [] }, { apiKeyBearer: [] }]);
});

test("Swagger and ReDoc are available without service bindings", async () => {
  for (const path of ["/docs", "/redocs"]) {
    const response = await handleRequest(new Request(`https://api.mainbrella.com${path}`), {} as Env);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("content-type") || "", /text\/html/);
    assert.match(await response.text(), /openapi\.json/);
  }
});

test('preview schemas specify generation, authentication, shared limits and retryable reconciliation', async () => {
  const { paths } = await document();
  const previews = paths['/containers/previews'];
  const body = previews.post.requestBody.content['application/json'].schema;
  assert.equal(body.properties.port.minimum, 1024);
  assert.equal(body.properties.port.maximum, 65535);
  assert.equal(body.properties.ttlSeconds.minimum, 60);
  assert.equal(body.properties.ttlSeconds.maximum, 3600);
  assert.deepEqual(body.required, ['port']);
  assert.equal(body.additionalProperties, false);
  assert.ok(previews.post.responses[201]);
  assert.ok(previews.post.responses[503].content['application/json'].schema.properties.previewId);
  assert.ok(previews.delete.responses[503].content['application/json'].schema.properties.previewId);
  for (const method of ['get', 'post', 'delete']) {
    assert.deepEqual(previews[method].security, [{ cookieAuth: [] }, { sessionBearer: [] }, { apiKeyBearer: [] }]);
    for (const name of ['id', 'createdAt']) assert.ok(previews[method].parameters.some((p: any) => p.name === name && p.required));
  }
  assert.ok(previews.delete.parameters.some((p: any) => p.name === 'previewId' && p.required));
  assert.match(previews.post.description, /bearer capabilities/);
  assert.match(previews.post.description, /Cookies are stripped/);
});

test('file schemas describe raw binary transport, generation identity and bounded writes', async () => {
  const { paths } = await document();
  const files = paths['/containers/files'];
  assert.equal(files.get.operationId, 'readContainerFile');
  assert.equal(files.put.operationId, 'writeContainerFile');
  assert.equal(files.get.responses[200].content['application/octet-stream'].schema.format, 'binary');
  assert.equal(files.put.requestBody.content['application/octet-stream'].schema.format, 'binary');
  assert.equal(files.put.requestBody.required, false);
  assert.deepEqual(files.put.security, [{ cookieAuth: [] }, { sessionBearer: [] }, { apiKeyBearer: [] }]);
  for (const name of ['id', 'createdAt', 'path']) assert.ok(files.get.parameters.some((p: any) => p.name === name && p.required));
  assert.match(files.put.description, /atomic rename/);
  assert.match(files.get.description, /1048576 bytes/);
});

test("registered routes forward untouched requests, streaming responses, bindings, and execution context", async () => {
  const request = new Request("https://api.mainbrella.com/containers", { method: "POST", body: "raw request body" });
  const env = {} as Env;
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("streamed")); controller.close(); } }), { headers: { "x-handler": "preserved" } });
  const app = createOpenAPIApp(async (received, bindings, context) => {
    assert.equal(received, request);
    assert.equal(bindings, env);
    assert.equal(context, ctx);
    assert.equal(await received.text(), "raw request body");
    return response;
  });
  const result = await app.fetch(request, env, ctx);
  assert.equal(result, response);
  assert.equal(result.headers.get("x-handler"), "preserved");
  assert.equal(await result.text(), "streamed");
});

test("WebSocket upgrade responses pass through without reconstruction", async () => {
  // Node cannot construct a real 101 Response; model the Worker response here.
  const response = new Response(null);
  Object.defineProperty(response, "status", { value: 101 });
  const webSocket = {};
  Object.defineProperty(response, "webSocket", { value: webSocket });
  const app = createOpenAPIApp(async () => response);
  const result = await app.request("https://api.mainbrella.com/containers/terminal", undefined, {} as Env);
  assert.equal(result, response);
  assert.equal(result.status, 101);
  assert.equal((result as Response & { webSocket: unknown }).webSocket, webSocket);
});

test("fallback preserves preflight, unsupported methods, and unknown paths", async () => {
  const preflight = await handleRequest(new Request("https://api.mainbrella.com/containers", { method: "OPTIONS", headers: { Origin: "http://localhost:5173" } }), {} as Env);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "http://localhost:5173");
  const unsupported = await handleRequest(new Request("https://api.mainbrella.com/containers", { method: "PATCH" }), {} as Env);
  assert.equal(unsupported.status, 405);
  assert.equal((await unsupported.json() as { error: string }).error, "method_not_allowed");
  const head = await handleRequest(new Request("https://api.mainbrella.com/state", { method: "HEAD" }), {} as Env);
  assert.equal(head.status, 405);
  const unknown = await handleRequest(new Request("https://api.mainbrella.com/images/not-an-id"), {} as Env);
  assert.equal(unknown.status, 404);
  const invalid = await handleRequest(new Request("https://api.mainbrella.com/auth/email", { method: "POST", headers: { "content-type": "application/json" }, body: "invalid JSON" }), {} as Env);
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "invalid_request" });
});

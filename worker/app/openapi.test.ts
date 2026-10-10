import test from "node:test";
import assert from "node:assert/strict";
import { createOpenAPIApp } from "./openapi";
import { handleRequest } from "./router";

const endpointMethods: Record<string, string[]> = {
  '/build/config': ['get'], '/build/apps': ['get', 'post'], '/build/apps/{appId}': ['get', 'patch', 'delete'],
  '/build/apps/{appId}/turns': ['post'], '/build/apps/{appId}/resume': ['post'], '/build/apps/{appId}/stop': ['post'],
  '/build/apps/{appId}/source': ['get'], '/build/apps/{appId}/export': ['get'], '/build/apps/{appId}/events': ['get'],
  '/build/apps/{appId}/images/{imageId}': ['get'],
  '/repo-launches': ['post'], '/repo-launches/resolve': ['get'],
  '/repo-launches/{launchId}': ['get'], '/repo-launches/{launchId}/advance': ['post'],
  '/private-services/networks': ['get', 'post', 'delete'], '/private-services/members': ['put', 'delete'],
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
  "/projects": ["get", "patch", "post"],
  '/projects/endpoint': ['get', 'put', 'delete'],
  '/projects/domains': ['get', 'post', 'delete'],
  '/projects/domains/verify': ['post'],
  "/health": ["get"], "/state": ["get"],
  "/auth/google": ["post"], "/auth/email": ["post"], "/auth/me": ["get"], "/auth/logout": ["post"],
  "/auth/app/google": ["post"], "/auth/app/email": ["post"], "/auth/app/apple": ["post"],
  "/auth/app/anonymous": ["post"], "/auth/app/me": ["get", "delete"],
  "/auth/app/refresh": ["post"], "/auth/app/logout": ["post"],
  "/subscription/config": ["get"], "/subscription": ["get"],
  "/subscription/trial": ["post"], "/subscription/checkout": ["post"], "/subscription/complete": ["post"], "/subscription/portal": ["post"],
  "/subscription/change": ["post"], "/subscription/cancel": ["post"], "/subscription/resume": ["post"],
  "/subscription/usage": ["get", "post"], "/subscription/webhook": ["post"], "/containers": ["get", "post", "delete"],
  '/billing/config': ['get'], '/billing/balance': ['get'], '/billing/history': ['get'], '/billing/topups': ['post'], '/billing/topups/complete': ['post'], '/billing/settings': ['post'],
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
  "/admin/users": ["get"], "/admin/tables": ["get"], "/admin/tables/{table}": ["get"],
  '/admin/accounting/ledger': ['get'], '/admin/accounting/closes': ['get', 'post'], '/admin/accounting/policies': ['get', 'post'],
  '/acquisition/repositories': ['post'], '/acquisition/link': ['post'],
  '/admin/acquisition/leads': ['get'], '/admin/acquisition/events': ['get'],
};

async function document() {
  const response = await handleRequest(new Request("https://api.mainbrella.com/openapi.json"), {} as Env);
  assert.equal(response.status, 200);
  return response.json() as Promise<any>;
}

test('accounting schemas describe protected exports, immutable revisions and explicit CPA methods', async () => {
  const { paths, components } = await document();
  for (const path of ['/admin/accounting/ledger', '/admin/accounting/closes', '/admin/accounting/policies']) {
    for (const operation of Object.values(paths[path]) as any[]) {
      assert.deepEqual(operation.security, [{ cookieAuth: [] }]);
      assert.match(operation.description, /oneone@gmail\.com/);
      assert.ok(operation.responses[403]);
    }
  }
  const ledger = paths['/admin/accounting/ledger'].get;
  assert.ok(ledger.responses[200].content['application/x-ndjson']);
  const order = ledger.parameters.find((parameter: any) => parameter.name === 'order');
  assert.deepEqual(order.schema.enum, ['asc', 'desc']);
  assert.match(ledger.description, /recorded_at descending, then sequence descending/);
  assert.match(ledger.description, /15-minute intervals/);
  assert.match(ledger.description, /does not flush buffered usage/);
  assert.match(paths['/admin/accounting/closes'].post.description, /null until a CPA-approved policy/);
  assert.match(paths['/admin/accounting/policies'].post.description, /does not create refund rights/);
  assert.ok(components.schemas.AccountingCloseReport.properties.customerComputeCredits);
  assert.ok(components.schemas.AccountingCloseReport.properties.deferredRevenue);
  assert.ok(components.schemas.AccountingCloseReport.properties.taxableAdvancePaymentsByReceiptYear);
});

test('Private Services schemas expose account authentication, exact generations, and HTTP-only registration', async () => {
  const { paths, components } = await document();
  const registration = paths['/private-services/members'].put;
  assert.deepEqual(registration.security, [{ cookieAuth: [] }, { sessionBearer: [] }, { apiKeyBearer: [] }]);
  assert.ok(registration.parameters.some((p: any) => p.name === 'network' && p.required));
  assert.deepEqual(components.schemas.PrivateServiceMember.required, ['id', 'createdAt', 'name']);
  assert.equal(components.schemas.PrivateServiceMember.properties.port.minimum, 1024);
  assert.equal(components.schemas.PrivateServiceMember.additionalProperties, false);
  assert.match(registration.description, /No arbitrary TCP/);
  assert.match(registration.description, /exact running generations/);
  assert.ok(paths['/private-services/networks'].post.responses['201']);
});

test('project schemas document optional domains, owner-scoped updates and request validation', async () => {
  const { paths } = await document();
  const create = paths['/projects'].post;
  const createBody = create.requestBody.content['application/json'].schema;
  assert.equal(createBody.properties.domain.maxLength, 253);
  assert.deepEqual(createBody.properties.domain.type, ['string', 'null']);
  assert.ok(!createBody.required?.includes('domain'));
  assert.match(create.description, /blank or null values are stored as null/);
  const update = paths['/projects'].patch;
  assert.equal(update.operationId, 'updateProject');
  assert.deepEqual(update.security, [{ cookieAuth: [] }]);
  assert.ok(update.parameters.some((parameter: any) => parameter.in === 'query' && parameter.name === 'id' && parameter.required && parameter.schema.format === 'uuid'));
  const body = update.requestBody.content['application/json'].schema;
  assert.equal(body.properties.name.minLength, 1);
  assert.equal(body.properties.name.maxLength, 80);
  assert.equal(body.properties.domain.maxLength, 253);
  assert.deepEqual(body.properties.domain.type, ['string', 'null']);
  assert.match(update.description, /omitted domain is preserved/);
  assert.deepEqual(update.responses[200].content['application/json'].schema.properties.project.properties.domain.type, ['string', 'null']);
  for (const status of [200, 400, 401, 403, 404, 503]) assert.ok(update.responses[status]);
  assert.match(update.description, /project owned by the signed-in user/);
});

test('Build configuration describes the opt-in local Codex provider and preserves cookie authentication', async () => {
  const { paths } = await document();
  const config = paths['/build/config'].get;
  assert.equal(config.operationId, 'getBuildConfig');
  assert.deepEqual(config.security, [{ cookieAuth: [] }]);
  assert.match(config.description, /Production uses Workers AI/);
  assert.match(config.description, /local development.*Codex app-server/);
  assert.equal(config.responses[200].content['application/json'].schema.properties.model.type, 'string');
});

test('project hosting schemas describe local aliases and simulated DNS and TLS', async () => {
  const { paths, components } = await document();
  const endpoint = paths['/projects/endpoint'].get;
  const addDomain = paths['/projects/domains'].post;
  const verifyDomain = paths['/projects/domains/verify'].post;
  const capabilities = components.schemas.Capabilities.properties.projects;
  assert.equal(endpoint.responses[200].content['application/json'].schema.properties.hosting.properties.localDevelopment.type, 'boolean');
  assert.equal(capabilities.properties.localDevelopment.type, 'boolean');
  assert.match(endpoint.description, /app\.localhost/);
  assert.match(addDomain.description, /PROJECT_DOMAIN_PROVIDER=local/);
  assert.match(addDomain.description, /no external provider/);
  assert.match(verifyDomain.description, /first verification/);
  assert.match(verifyDomain.description, /second verification/);
});

test("admin users schema documents restricted cookie access and safe user fields", async () => {
  const { paths, components } = await document();
  const operation = paths["/admin/users"].get;
  assert.deepEqual(operation.security, [{ cookieAuth: [] }]);
  assert.equal(operation.operationId, "listAdminUsers");
  assert.match(operation.description, /oneone@gmail\.com/);
  assert.match(operation.description, /created_at descending/);
  for (const status of [200, 401, 403, 405, 503]) assert.ok(operation.responses[status]);
  assert.ok(operation.responses[200].content["application/json"].schema.properties.users);
  const planFields = components.schemas.AdminUser.allOf.find((schema: any) => schema.properties?.plan);
  assert.deepEqual(planFields.properties.plan.enum, ['none', 'builder', 'pro', 'scale']);
  assert.ok(planFields.required.includes('plan'));
});

test('workspace schemas describe capture budgets, usage and nonrefundable deletion', async () => {
  const {paths}=await document();
  const list=paths['/workspaces'].get.responses['200'].content['application/json'].schema;
  const limits=list.properties.limits;
  for(const field of ['maxCaptureBytesPerMonth','maxRetainedCaptureBytes'])assert.ok(limits.properties[field]);
  for(const field of ['savesThisMonth','captureBytesThisMonth','retainedCaptureBytes'])assert.ok(list.properties.usage.properties[field]);
  assert.match(paths['/workspaces'].post.description,/workspace_capture_budget_exceeded/);
  assert.match(paths['/workspaces'].post.description,/workspace_retained_budget_exceeded/);
  assert.match(paths['/workspaces/{workspaceId}'].delete.description,/does not refund/);
});

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

test('prepaid schemas expose one-time funding, payment verification and consent-based auto recharge', async () => {
  const { paths, components } = await document();
  assert.deepEqual(paths['/billing/balance'].get.security, [{ cookieAuth: [] }]);
  assert.deepEqual(paths['/billing/history'].get.security, [{ cookieAuth: [] }]);
  assert.equal(paths['/billing/history'].get.operationId, 'getPrepaidHistory');
  assert.match(paths['/billing/history'].get.description, /unattributedUsedCents/);
  assert.equal(paths['/billing/history'].get.parameters.find((parameter: any) => parameter.name === 'limit').schema.maximum, 100);
  const purchase = paths['/billing/topups'].post;
  assert.deepEqual(purchase.security, [{ cookieAuth: [] }]);
  assert.match(purchase.summary, /embedded Stripe Checkout/);
  assert.match(purchase.description, /publishable key/);
  assert.deepEqual(Object.keys(purchase.responses['200'].content['application/json'].schema.properties).sort(), ['client_secret', 'publishable_key', 'sessionId'].sort());
  assert.match(purchase.description, /No subscription is created/);
  assert.match(purchase.description, /Stripe promotion codes/);
  assert.match(purchase.description, /selected amountCents remains the compute balance purchased/);
  assert.match(purchase.description, /no-payment-required/);
  assert.match(purchase.description, /client-supplied credit amounts never authorize/i);
  const body = purchase.requestBody.content['application/json'].schema;
  assert.equal(body.properties.amountCents.minimum, 500);
  assert.equal(body.properties.amountCents.maximum, 100000);
  assert.equal(body.properties.requestId.format, 'uuid');
  assert.match(paths['/billing/topups/complete'].post.description, /Pending payments do not increase/);
  assert.match(paths['/billing/topups/complete'].post.description, /Refunds revoke the corresponding proportion/);
  assert.match(paths['/billing/settings'].post.description, /explicitly authorizes/);
  assert.ok(components.schemas.PrepaidBalance.properties.autoRecharge);
  assert.ok(components.schemas.PrepaidBalance.properties.availableBalanceCents);
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
  assert.match(paths["/subscription/checkout"].post.description, /usage billing requires explicitly configured test-mode recurring price/);
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
  const invalid = await handleRequest(new Request("https://api.mainbrella.com/auth/email", { method: "POST", headers: { "content-type": "application/json", "CF-Connecting-IP": "192.0.2.1" }, body: "invalid JSON" }), { EMAIL_AUTH_LIMIT: { limit: async () => ({ success: true }) } } as unknown as Env);
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "invalid_request" });
});

test("signup schemas document welcome email behavior and public authentication", async () => {
  const { paths } = await document();
  for (const path of ["/auth/email", "/auth/google", "/auth/app/google", "/auth/app/apple"]) {
    assert.match(paths[path].post.description, /welcome email/);
    assert.match(paths[path].post.description, /delivery failures do not fail signup/);
    assert.deepEqual(paths[path].post.security, []);
  }
});


test('production schemas document lifecycle, startup commands, stopped services and network filtering', async () => {
  const document = await (await handleRequest(new Request('https://api.mainbrella.com/openapi.json'), {} as Env)).json() as any;
  const body = document.paths['/containers'].post.requestBody.content['application/json'].schema;
  assert.deepEqual(body.properties.lifecycle.enum, ['ad_hoc', 'production']);
  assert.equal(body.properties.startupCommand.maxLength, 4096);
  const network = document.paths['/private-services/networks'];
  assert.ok(network.get.parameters.some((parameter: any) => parameter.name === 'lifecycle'));
  assert.deepEqual(network.post.requestBody.content['application/json'].schema.properties.lifecycle.enum, ['ad_hoc', 'production']);
});

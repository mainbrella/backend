import test from "node:test";
import assert from "node:assert/strict";
import { createOpenAPIApp } from "./openapi";
import { handleRequest } from "./router";
import { serviceForPath } from "../shared/service-routing";

const endpointMethods: Record<string, string[]> = {
  '/pools': ['get', 'post'], '/pools/{poolId}': ['get', 'patch', 'delete'], '/pools/{poolId}/acquire': ['post'],
  '/secrets': ['get', 'post'], '/secrets/{secretId}': ['put', 'delete'],
  '/containers/stop': ['post'], '/containers/resume': ['post'], '/containers/fork': ['post'],
  '/containers/startup': ['patch'],
  '/domains/config': ['get'], '/domains': ['get'], '/domains/search': ['post'], '/domains/quote': ['post'],
  '/domains/checkout': ['post'], '/domains/order': ['get'], '/domains/detail': ['get'], '/domains/settings': ['patch'],
  '/domains/verification': ['post'], '/domains/records': ['post', 'delete'], '/domains/auth-code': ['post'],
  '/domains/connect': ['post'],
  '/github/import/config': ['get'], '/github/import/connect': ['post'], '/github/import/connection': ['get', 'delete'],
  '/github/import/callback': ['get'], '/github/import/setup': ['get'],
  '/github/build/config': ['get'], '/github/build/connect': ['post'], '/github/build/connection': ['get'],
  '/github/build/callback': ['get'], '/github/build/setup': ['get'], '/github/build/repositories': ['get'], '/projects/github': ['get', 'put'],
  '/projects/github/storage': ['delete'],
  '/build/config': ['get'], '/build/apps': ['get', 'post'], '/build/events': ['get'], '/build/apps/{appId}': ['get', 'patch', 'delete'],
  '/build/apps/{appId}/turns': ['post'], '/build/apps/{appId}/resume': ['post'], '/build/apps/{appId}/stop': ['post'],
  '/build/apps/{appId}/source': ['get'], '/build/apps/{appId}/export': ['get'], '/build/apps/{appId}/events': ['get'],
  '/build/apps/{appId}/files': ['get'], '/build/apps/{appId}/file': ['get'],
  '/build/apps/{appId}/images/{imageId}': ['get'],
  '/build/apps/{appId}/turns/{turnId}/diagnostics': ['get'],
  '/build/apps/{appId}/versions': ['get'], '/build/apps/{appId}/versions/{versionId}': ['get'],
  '/build/apps/{appId}/restore': ['post'], '/build/apps/{appId}/repository': ['get'],
  '/voice/config': ['get'], '/voice/agent': ['get', 'put'], '/voice/calls': ['get', 'post'],
  '/voice/calls/{callId}': ['get'], '/voice/calls/{callId}/end': ['post'], '/voice/calls/{callId}/connect': ['get'],
  '/voice/twilio/incoming/{agentId}': ['post'], '/voice/twilio/media/{callId}': ['get'],
  '/repo-launches': ['post'], '/repo-launches/resolve': ['get'],
  '/repo-launches/{launchId}': ['get'], '/repo-launches/{launchId}/advance': ['post'],
  '/private-services/networks': ['get', 'post', 'delete'], '/private-services/members': ['put', 'delete'],
  '/workspaces': ['get','post'], '/workspaces/{workspaceId}': ['get','patch','delete'], '/containers/export': ['get'],
  '/capabilities': ['get'],
  '/containers/activity': ['get'],
  '/status': ['get'], '/status/history': ['get'],
  '/internal/status/observations': ['post'], '/internal/status/incidents': ['post'],
  '/containers/executions': ['get', 'post'],
  '/containers/code-contexts': ['get', 'post'],
  '/containers/code-contexts/{contextId}': ['delete'],
  '/containers/code-contexts/{contextId}/execute': ['post'],
  '/containers/executions/{executionId}/stdin': ['post', 'delete'],
  '/containers/executions/{executionId}/signal': ['post'],
  '/containers/executions/{executionId}/resize': ['post'],
  '/containers/previews': ['get', 'post', 'delete'],
  '/containers/events': ['get'], '/containers/metrics': ['get'],
  '/containers/telemetry/logs': ['get'], '/containers/telemetry/metrics': ['get'],
  '/containers/webhook': ['get', 'put', 'delete'], '/containers/webhook/deliveries': ['get'], '/containers/webhook/retry': ['post'],
  '/containers/executions/{executionId}': ['get', 'delete'],
  '/containers/executions/{executionId}/events': ['get'],
  "/api-keys": ["get", "post", "delete"],
  "/api-keys/me": ["get"],
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
  '/billing/storage': ['get'], '/admin/accounting/storage-invoices': ['get', 'post'],
  '/billing/config': ['get'], '/billing/balance': ['get'], '/billing/history': ['get'], '/billing/topups': ['post'], '/billing/topups/complete': ['post'], '/billing/settings': ['post'],
  '/billing/apple/config': ['get'], '/billing/apple/transactions': ['post'], '/billing/apple/notifications': ['post'],
  "/containers/ssh": ["post"], "/containers/terminal": ["get"],
  "/containers/exec": ["post"],
  "/containers/files": ["get", "put"],
  '/containers/files/transfer': ['get', 'put'],
  '/containers/files/list': ['get'], '/containers/files/stat': ['get'],
  '/containers/files/mkdir': ['post'], '/containers/files/remove': ['delete'],
  '/containers/files/move': ['post'], '/containers/files/chmod': ['patch'],
  "/ssh/validate": ["post"], "/ssh/connect": ["get"],
  "/images": ["get", "post"], "/images/{id}": ["get", "delete"], "/images/{id}/logs": ["get"],
  "/images/tags": ["get"], "/images/tags/{tag}": ["get", "put", "delete"],
  "/internal/image-builds/manifest": ["get"], "/internal/image-builds/deployment-lock": ["post", "delete"],
  "/internal/image-builds/{id}/source": ["post"], "/internal/image-builds/{id}/status": ["post"],
  "/admin/users": ["get"], "/admin/user-balances": ["get"], "/admin/users/{userId}": ["get"], "/admin/tables": ["get"], "/admin/tables/{table}": ["get"],
  "/api/get-marketing-users": ["get"],
  "/api/send-marketing-email": ["post"],
  "/api/unsubscribe": ["post"],
  '/admin/accounting/ledger': ['get'], '/admin/accounting/closes': ['get', 'post'], '/admin/accounting/policies': ['get', 'post'],
  '/acquisition/repositories': ['post'], '/acquisition/link': ['post'],
  '/admin/acquisition/leads': ['get'], '/admin/acquisition/events': ['get'],
};

async function document() {
  const response = await handleRequest(new Request("https://api.mainbrella.com/openapi.json"), {} as Env);
  assert.equal(response.status, 200);
  return response.json() as Promise<any>;
}

test('streamed downloads publish the length contract required by SDK consumers', async () => {
  const { paths } = await document();
  const download = paths['/containers/files/transfer'].get;
  assert.equal(download.operationId, 'downloadContainerFile');
  assert.deepEqual(download.security, [{ cookieAuth: [] }, { sessionBearer: [] }, { apiKeyBearer: [] }]);
  const length = download.responses[200].headers['Content-Length'];
  assert.equal(length.required, true);
  assert.deepEqual(length.schema, { type: 'integer', minimum: 0, maximum: 64 * 1024 * 1024 });
  assert.equal(download.responses[200].content['application/octet-stream'].schema.format, 'binary');
});

test('managed pool schemas describe bounded billed inventory and idempotent acquisition', async () => {
  const { paths, components } = await document();
  for (const path of ['/pools', '/pools/{poolId}/acquire']) {
    assert.deepEqual(paths[path].post.security, [{ cookieAuth: [] }, { sessionBearer: [] }, { apiKeyBearer: [] }]);
    assert.ok(paths[path].post.parameters.some((p: any) => p.name === 'Idempotency-Key' && p.required));
  }
  const create = paths['/pools'].post.requestBody.content['application/json'].schema;
  assert.deepEqual(create.required, ['name', 'targetSize', 'ttlSeconds']);
  assert.equal(create.properties.ttlSeconds.maximum, 86400);
  assert.equal(create.properties.targetSize.maximum, 20);
  assert.equal(create.additionalProperties, false);
  assert.equal(components.schemas.ManagedPool.properties.expiresAt.format, 'date-time');
  assert.equal(paths['/pools/{poolId}/acquire'].post.requestBody.required, false);
  assert.ok(paths['/pools/{poolId}/acquire'].post.responses[410]);
  assert.match(paths['/pools/{poolId}'].delete.description, /Acquired guests are unaffected/);
});

test('interpreter cleanup documents retryable closing contexts', async () => {
  const { paths } = await document();
  const cleanup = paths['/containers/code-contexts/{contextId}'].delete;
  assert.match(cleanup.description, /Failed cleanup retains the context ID/);
  assert.ok(cleanup.responses[503]);
  assert.ok(paths['/containers/code-contexts/{contextId}/execute'].post.responses[409]);
  assert.match(paths['/containers/code-contexts'].get.description, /closing contexts are omitted/);
});

test('P0 lifecycle and security schemas describe authenticated exact-generation requests and write-only values', async () => {
  const { paths, components } = await document();
  for (const action of ['stop', 'resume', 'fork']) {
    const operation = paths[`/containers/${action}`].post;
    assert.deepEqual(operation.security, [{ cookieAuth: [] }, { sessionBearer: [] }, { apiKeyBearer: [] }]);
    assert.ok(operation.parameters.some((p: any) => p.name === 'Idempotency-Key' && p.required));
    assert.deepEqual(operation.requestBody.content['application/json'].schema.required, ['id', 'createdAt']);
    assert.ok(operation.responses[409]); assert.ok(operation.responses[410]);
  }
  assert.equal(paths['/secrets'].post.requestBody.content['application/json'].schema.properties.value.maxLength, 4096);
  assert.equal(components.schemas.SecretMetadata.properties.value, undefined);
  assert.equal(components.schemas.SecretMetadata.properties.ciphertext, undefined);
  assert.ok(paths['/secrets/{secretId}'].delete.security.length);
  const create = paths['/containers'].post.requestBody.content['application/json'].schema;
  assert.equal(create.properties.networkPolicy.properties.allow.maxItems, 64);
  assert.equal(create.properties.secretBindings.maxItems, 16);
  assert.ok(components.schemas.Capabilities.properties.persistence.properties.filesystemFork);
  assert.ok(components.schemas.Capabilities.properties.secrets.properties.vault);
  assert.match(paths['/capabilities'].get.description, /authenticated account/);
  assert.deepEqual(paths['/capabilities'].get.security, [{ cookieAuth: [] }, { sessionBearer: [] }, { apiKeyBearer: [] }, {}]);
  assert.match(paths['/containers'].post.description, /operator rollout access/);
  assert.match(paths['/secrets'].post.description, /operator rollout access/);
  assert.match(paths['/secrets/{secretId}'].put.description, /operator rollout access/);
});
test('dedicated relay and acknowledgment services have separate authenticated OpenAPI contracts', async () => {
  const { createSecurityInfrastructureApp } = await import('./openapi');
  const ids = new Set<string>();
  for (const kind of ['relay', 'ack'] as const) {
    const service = createSecurityInfrastructureApp(kind, async () => new Response(null, { status: 404 }));
    const response = await service.request('http://local/openapi.json', undefined, {} as Env);
    const schema = await response.json() as any;
    for (const path of Object.values(schema.paths) as any[]) for (const operation of Object.values(path) as any[]) {
      assert.ok(operation.operationId); assert.ok(!ids.has(operation.operationId)); ids.add(operation.operationId);
    }
    if (kind === 'relay') {
      assert.deepEqual(schema.paths['/v1/egress'].post.security, [{ operatorBearer: [] }]);
      assert.ok(schema.paths['/v1/egress'].post.requestBody.content['application/json'].schema.properties.injections);
    } else {
      assert.deepEqual(schema.paths['/control/{runId}'].post.security, [{ operatorBearer: [] }]);
      assert.ok(schema.paths['/control/{runId}'].post.requestBody);
      assert.ok(schema.paths['/runs/{runId}/{action}'].get.responses[302]);
      assert.ok(schema.paths['/runs/{runId}/{action}'].get.responses[200].content['application/json'].schema.properties.authenticated);
      assert.ok(schema.paths['/runs/{runId}/{action}'].get.responses[200].content['text/plain']);
    }
  }
  const primary = await document(); assert.equal(primary.paths['/v1/egress'], undefined); assert.equal(primary.paths['/control/{runId}'], undefined);
});

test('service-owned endpoints document independent deployment and retain their public contracts', async () => {
  const { paths } = await document();
  for (const [path, methods] of Object.entries(endpointMethods)) {
    const service = serviceForPath(path);
    if (!service) continue;
    for (const method of methods) {
      const operation = paths[path][method];
      assert.match(operation.description, new RegExp(`independently deployed mainbrella-${service} Worker`));
      assert.ok(operation.responses[503], `${method} ${path}`);
      assert.deepEqual(operation.security, path === '/api/unsubscribe' ? [] : [{ cookieAuth: [] }]);
    }
  }
});

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
  assert.deepEqual(ledger.responses[200].content['application/json'].schema.properties.entries.items.properties.event_type.enum,
    ['funding', 'refund', 'stripe_balance', 'funding_state', 'compute', 'inference', 'storage', 'storage_adjustment', 'legacy_usage', 'wallet_checkpoint']);
  assert.match(ledger.description, /data\.costMicroUsd/);
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
  assert.equal(createBody.properties.git.type, 'boolean');
  assert.ok(!createBody.required?.includes('git'));
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
  assert.deepEqual(update.responses[200].content['application/json'].schema.properties.project.properties.build_app_id.type, ['string', 'null']);
  assert.deepEqual(update.responses[200].content['application/json'].schema.properties.project.properties.git_version_id.type, ['string', 'null']);
  assert.match(paths['/projects'].get.description, /including Builder apps/);
  for (const status of [200, 400, 401, 403, 404, 503]) assert.ok(update.responses[status]);
  assert.match(update.description, /project owned by the signed-in user/);
});

test('GitHub Build authorization documents the exact same-origin project return fields', async () => {
  const { paths } = await document();
  const connect = paths['/github/build/connect'].post;
  const body = connect.requestBody.content['application/json'].schema;
  assert.equal(body.properties.returnTo.type, 'string');
  assert.equal(body.properties.returnTo.pattern, '^\\/projects\\/');
  assert.match(connect.description, /Omit repo and branch/);
  assert.deepEqual(body.required, ['projectId']);
  assert.deepEqual(paths['/github/build/setup'].get.security, [{ cookieAuth: [] }]);
  const picker = paths['/github/build/repositories'].get;
  assert.deepEqual(picker.security, [{ cookieAuth: [] }]);
  assert.equal(picker.operationId, 'listGithubBuildRepositories');
  assert.ok(picker.responses[200].content['application/json'].schema.properties.nextCursor);
});

test('Build explanations document user guidance in progress snapshots and diagnostics', async () => {
  const { paths, components } = await document();
  const diagnostics = paths['/build/apps/{appId}/turns/{turnId}/diagnostics'].get.responses[200].content['application/json'].schema;
  for (const explanation of [
    components.schemas.BuildTurn.properties.activity.items.properties.explanation,
    components.schemas.BuildTurn.properties.errorExplanation,
    diagnostics.properties.operations.items.properties.explanation,
    diagnostics.properties.errorExplanation,
  ]) {
    assert.match(explanation.description, /whether to wait, check the app, or try again/);
    assert.deepEqual(explanation.type, ['string', 'null']);
  }
});

test('Build repository browsing documents manifests and authenticated individual R2 file streams', async () => {
  const { paths, components } = await document();
  const operation = paths['/build/apps/{appId}/versions/{versionId}'].get;
  assert.deepEqual(operation.security, [{ cookieAuth: [] }]);
  assert.match(operation.description, /without extracting the R2 bundle/);
  const schema = operation.responses[200].content['application/json'].schema;
  assert.equal(schema.properties.files.type, 'array');
  assert.equal(schema.properties.files.items.$ref, '#/components/schemas/BuildFile');
  assert.deepEqual(components.schemas.BuildFile.required, ['path', 'size', 'type']);
  assert.ok(!schema.properties.changes.items.properties.before);
  for (const path of ['/build/apps/{appId}/files', '/build/apps/{appId}/file']) {
    assert.deepEqual(paths[path].get.security, [{ cookieAuth: [] }]);
    const identifier = paths[path].get.parameters.find((param: any) => param.name === 'versionId').schema;
    assert.ok(identifier.anyOf.some((format: any) => format.format === 'uuid'));
    assert.ok(identifier.anyOf.some((format: any) => format.pattern === '^[a-f0-9]{40}$'));
  }
  const stream = paths['/build/apps/{appId}/file'].get;
  assert.equal(stream.parameters.find((param: any) => param.name === 'path').required, true);
  assert.ok(stream.responses[200].content['text/plain']);
  assert.ok(stream.responses[200].content['image/jpeg']);
  const repository = paths['/build/apps/{appId}/repository'].get;
  assert.equal(repository.operationId, 'exportBuildRepository');
  assert.deepEqual(repository.security, [{ cookieAuth: [] }]);
  assert.match(repository.description, /without paid access or a running sandbox/);
  assert.match(repository.description, /one self-contained Git bundle/);
  assert.ok(repository.responses[200].content['application/octet-stream']);
});

test('Builder source and GitHub linking document storage bounds separately from model context', async () => {
  const { paths } = await document();
  const source = paths['/build/apps/{appId}/source'].get;
  assert.equal(source.responses[200].content['application/json'].schema.properties.files.additionalProperties.maxLength, 1024 * 1024);
  for (const operation of [source, paths['/projects/github'].put]) {
    assert.match(operation.description, /1024.*files/);
    assert.match(operation.description, /1 MiB per/);
    assert.match(operation.description, /16 MiB.*serialized source/);
    assert.match(operation.description, /D1.*object reference/);
    assert.deepEqual(operation.security, [{ cookieAuth: [] }]);
  }
  const link = paths['/projects/github'].put;
  assert.equal(link.operationId, 'linkProjectGithub');
  assert.ok(link.responses[402]); assert.ok(link.responses[413]);
  assert.match(link.description, /retains the Mainbrella working copy/);
  const deletion = paths['/projects/github/storage'].delete;
  assert.equal(deletion.operationId, 'deleteProjectHostedStorage');
  assert.deepEqual(deletion.security, [{ cookieAuth: [] }]);
  assert.ok(deletion.parameters.some((parameter: any) => parameter.name === 'Origin' && parameter.required));
  assert.ok(deletion.parameters.some((parameter: any) => parameter.name === 'id' && parameter.required));
  assert.ok(deletion.responses[409]); assert.ok(deletion.responses[202]);
  assert.match(deletion.description, /github_source_not_pushed/);
  assert.match(deletion.description, /Preserves project identity, Builder access/);
  assert.deepEqual(paths['/projects'].get.responses[200].content['application/json'].schema.properties.projects.items.properties.github_storage.enum, ['retained', 'deleting', 'github', null]);
});

test('Build configuration describes the opt-in local Codex provider and preserves cookie authentication', async () => {
  const { paths } = await document();
  const config = paths['/build/config'].get;
  assert.equal(config.operationId, 'getBuildConfig');
  assert.deepEqual(config.security, [{ cookieAuth: [] }]);
  assert.match(config.description, /Production uses Workers AI/);
  assert.match(config.description, /local development.*Codex app-server/);
  assert.match(config.description, /curated list of three models/);
  assert.match(config.description, /high \(default\) or max/);
  assert.equal(config.responses[200].content['application/json'].schema.properties.model.type, 'string');
  assert.equal(config.responses[200].content['application/json'].schema.properties.models.type, 'array');
  assert.equal(config.responses[200].content['application/json'].schema.properties.models.items.properties.description.type, 'string');
  assert.ok(!('dailyTurns' in config.responses[200].content['application/json'].schema.properties));
  assert.match(config.description, /no daily turn quota/i);
  for (const path of ['/build/apps', '/build/apps/{appId}/turns']) {
    assert.match(paths[path].post.description, /available.*balance/);
    assert.match(paths[path].post.description, /account spending limit/);
    assert.match(paths[path].post.description, /No daily turn quota/);
    assert.ok(paths[path].post.responses[402]);
  }
  const creation = paths['/build/apps'].post.requestBody.content['application/json'].schema.properties;
  assert.equal(creation.model.type, 'string'); assert.equal(creation.effort.type, 'string');
  const accountStream = paths['/build/events'].get;
  assert.equal(accountStream.operationId, 'streamBuildAccount');
  assert.deepEqual(accountStream.security, [{ cookieAuth: [] }]);
  assert.ok(accountStream.responses[200].content['text/event-stream']);
  assert.match(accountStream.description, /six starts per minute and two concurrent streams per account/);
  assert.match(paths['/build/apps'].post.description, /separate apps may build concurrently/);
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
  assert.equal(operation.responses[200].content['application/json'].schema.properties.users.items.$ref,
    '#/components/schemas/AdminUserListItem');
  const includeBalances = operation.parameters.find((parameter: any) => parameter.name === 'includeBalances');
  assert.deepEqual(includeBalances.schema.enum, ['true', 'false']);
  assert.match(operation.description, /without accessing wallet services/);
});

test("admin balance batches document indexed user selection and restricted live wallet reads", async () => {
  const { paths, components } = await document();
  const operation = paths['/admin/user-balances'].get;
  assert.equal(operation.operationId, 'getAdminUserBalances');
  assert.deepEqual(operation.security, [{ cookieAuth: [] }]);
  assert.match(operation.description, /WHERE id IN/);
  assert.match(operation.description, /at most five concurrent reads/);
  for (const status of [200, 400, 401, 403, 405, 503]) assert.ok(operation.responses[status]);
  const ids = operation.parameters.find((parameter: any) => parameter.name === 'id');
  assert.equal(ids.required, true);
  assert.equal(ids.schema.minItems, 1);
  assert.equal(ids.schema.maxItems, 30);
  const balance = components.schemas.AdminUserBalance;
  assert.deepEqual(balance.properties.balanceCents.type, ['integer', 'null']);
  assert.ok(balance.required.includes('balanceCents'));
});

test("marketing users schema documents admin access, opt-outs and bounded pagination", async () => {
  const { paths, components } = await document();
  const operation = paths["/api/get-marketing-users"].get;
  assert.equal(operation.operationId, "getMarketingUsers");
  assert.deepEqual(operation.security, [{ cookieAuth: [] }]);
  assert.match(operation.description, /oneone@gmail\.com/);
  assert.match(operation.description, /marketing_email_unsubscribed/);
  assert.match(operation.description, /permanent address opt-out/);
  assert.match(operation.description, /another unsubscribed account/);
  assert.match(operation.description, /created_at descending, then id descending/);
  const offset = operation.parameters.find((parameter: any) => parameter.name === "offset");
  assert.equal(offset.in, "query");
  assert.equal(offset.required, false);
  assert.equal(offset.schema.minimum, 0);
  assert.equal(offset.schema.maximum, 1_000_000);
  assert.equal(offset.schema.default, 0);
  const limit = operation.parameters.find((parameter: any) => parameter.name === "limit");
  assert.equal(limit.in, "query");
  assert.equal(limit.required, false);
  assert.equal(limit.schema.minimum, 1);
  assert.equal(limit.schema.maximum, 100);
  assert.equal(limit.schema.default, 25);
  const response = operation.responses[200].content["application/json"].schema;
  assert.deepEqual(response.required, ["users", "total", "offset", "limit"]);
  assert.equal(response.properties.users.items.$ref, "#/components/schemas/MarketingUser");
  assert.deepEqual(Object.keys(components.schemas.MarketingUser.properties).sort(), ["created_at", "email", "id", "name"]);
  assert.deepEqual(components.schemas.MarketingUser.properties.email.type, ["string", "null"]);
  for (const status of [200, 400, 401, 403, 405, 503]) assert.ok(operation.responses[status]);
});

test("marketing email schema describes admin access, input, and acceptance", async () => {
  const { paths } = await document();
  const operation = paths["/api/send-marketing-email"].post;
  assert.equal(operation.operationId, "sendMarketingEmail");
  assert.deepEqual(operation.security, [{ cookieAuth: [] }]);
  assert.match(operation.description, /oneone@gmail\.com/);
  assert.match(operation.description, /does not confirm inbox delivery/);
  assert.match(operation.description, /plain text/);
  assert.ok(operation.parameters.some((parameter: any) => parameter.in === "header" && parameter.name === "Origin" && parameter.required));
  const body = operation.requestBody.content["application/json"].schema;
  assert.deepEqual(body.required, ["to", "subj", "from", "message"]);
  assert.equal(body.additionalProperties, false);
  assert.equal(body.properties.to.format, "email");
  assert.equal(body.properties.subj.maxLength, 998);
  assert.equal(body.properties.from.maxLength, 512);
  assert.equal(body.properties.message.maxLength, 100_000);
  assert.equal(body.properties.fancy.type, "boolean");
  assert.equal(body.properties.fancy.default, true);
  assert.match(operation.description, /fancy=false/);
  assert.match(operation.description, /white background with a normal font/);
  assert.match(operation.description, /In both modes, both parts include an unsubscribe link/);
  assert.match(operation.description, /simple unsubscribe footer/);
  for (const status of [202, 400, 401, 403, 405, 409, 413, 429, 502, 503]) assert.ok(operation.responses[status]);
  assert.ok(operation.responses[202].content["application/json"].schema.properties.messageId);
  assert.match(operation.description, /marketing_email_unsubscribed/);
  assert.match(operation.description, /before every send/);
  assert.match(operation.description, /email_preferences_unavailable without sending/);
});

test("unsubscribe schema documents public, permanent, address-based opt-outs", async () => {
  const { paths } = await document();
  const operation = paths["/api/unsubscribe"].post;
  assert.equal(operation.operationId, "unsubscribeMarketingEmail");
  assert.deepEqual(operation.security, []);
  const body = operation.requestBody.content["application/json"].schema;
  assert.deepEqual(body.required, ["email"]);
  assert.equal(body.additionalProperties, false);
  assert.equal(body.properties.email.format, "email");
  assert.match(operation.description, /idempotent/);
  assert.match(operation.description, /current session does not determine the recipient/);
  for (const status of [200, 400, 403, 405, 413, 503]) assert.ok(operation.responses[status]);
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

test('admin user detail documents safe prepaid funding and its allowlisted cookie protection', async () => {
  const { paths } = await document();
  const detail = paths['/admin/users/{userId}'].get;
  assert.equal(detail.operationId, 'getAdminUserDetail');
  assert.deepEqual(detail.security, [{ cookieAuth: [] }]);
  assert.match(detail.description, /oneone@gmail\.com/);
  assert.match(detail.description, /no Stripe requests or billing mutations/);
  assert.ok(detail.parameters.some((parameter: any) => parameter.in === 'path' && parameter.name === 'userId' && parameter.required));
  assert.equal(detail.parameters.find((parameter: any) => parameter.name === 'limit').schema.maximum, 100);
  assert.equal(detail.responses['200'].content['application/json'].schema.properties.balance.$ref, '#/components/schemas/PrepaidBalance');
  assert.deepEqual(Object.keys(detail.responses['200'].content['application/json'].schema.properties).sort(),
    ['asOf', 'balance', 'fundings', 'nextFundingCursor', 'user']);
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
  assert.equal(multipart.properties.cacheFrom.format, 'uuid');
  assert.equal(multipart.properties.baseImage.type, 'string');
  assert.deepEqual(multipart.required, ["name", "dockerfile"]);
  const imageList = paths['/images'].get.responses[200].content['application/json'].schema;
  assert.equal(imageList.properties.privateRegistriesEnabled.type, 'boolean');
  const claim = paths['/internal/image-builds/{id}/source'].post;
  assert.deepEqual(claim.security, [{ imageBuild: [] }]);
  assert.match(claim.description, /One-use claim/);
  const source = claim.responses[200].content['application/json'].schema.properties;
  assert.ok(source.baseImage);
  assert.ok(source.cacheImage);
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


test('Build commit schemas document the file limit and complete prepaid storage funding', async () => {
  const { paths } = await document();
  const turns = paths['/build/apps/{appId}/turns'].post;
  assert.match(turns.description, /25 MiB \(26,214,400 uncompressed bytes\)/);
  assert.match(turns.description, /storage_funding_required/);
  assert.match(turns.description, /build_git_file_limit/);
  assert.match(turns.description, /30-day retention/);
  assert.match(paths['/build/apps/{appId}/restore'].post.description, /storage_funding_required/);
});


test('Storage schemas expose 30-day warnings, exact deletion dates, exports and throttling', async () => {
  const { paths, components } = await document();
  const summary = components.schemas.StorageBillingSummary;
  assert.deepEqual(summary.properties.pricing.properties.retentionDays.enum, [30]);
  assert.ok(components.schemas.StorageRetention.properties.deletionAt);
  assert.ok(summary.properties.projects.items.properties.exportUrl);
  assert.match(paths['/billing/storage'].get.description, /undelivered warning blocks deletion/);
  const repository = paths['/build/apps/{appId}/repository'].get;
  assert.ok(repository.responses[429]);
  assert.match(repository.description, /two concurrent exports/);
  assert.ok(paths['/build/apps/{appId}'].get.responses[200].content['application/json'].schema.properties.app.allOf[1].properties.retention);
});

test('AI receptionist schemas describe bounded configuration, calls, and signed provider WebSockets', async () => {
  const { paths, components } = await document();
  assert.deepEqual(paths['/voice/agent'].put.security, [{ cookieAuth: [] }]);
  const agentBody = paths['/voice/agent'].put.requestBody.content['application/json'].schema;
  assert.deepEqual(agentBody.required, ['name', 'businessName', 'greeting', 'instructions', 'voice', 'transferNumber']);
  assert.equal(agentBody.additionalProperties, false);
  assert.equal(agentBody.properties.name.maxLength, 80);
  assert.equal(agentBody.properties.businessName.maxLength, 120);
  assert.equal(agentBody.properties.greeting.maxLength, 500);
  assert.equal(agentBody.properties.instructions.maxLength, 8000);
  assert.deepEqual(agentBody.properties.voice.enum, ['asteria', 'luna', 'athena']);
  assert.deepEqual(agentBody.properties.transferNumber.type, 'null');
  assert.equal(paths['/voice/calls'].get.responses[200].content['application/json'].schema.properties.calls.maxItems, 50);
  assert.equal(components.schemas.VoiceCall.properties.transcript.maxItems, 121);
  assert.deepEqual(components.schemas.VoiceCall.properties.phoneTransport.type,['string','null']);
  assert.deepEqual(components.schemas.VoiceCall.properties.phoneTransport.enum,['pstn','sip',null]);
  const telephony=paths['/voice/config'].get.responses[200].content['application/json'].schema.properties.telephony;
  assert.ok(telephony.required.includes('sipUri'));
  assert.deepEqual(telephony.properties.sipUri.type,['string','null']);
  assert.ok(paths['/voice/calls/{callId}/connect'].get.responses[101]);
  assert.deepEqual(paths['/voice/calls/{callId}/connect'].get.security, [{ cookieAuth: [] }]);
  assert.ok(paths['/voice/twilio/media/{callId}'].get.responses[101]);
  assert.deepEqual(paths['/voice/twilio/media/{callId}'].get.security, [{ twilioSignature: [] }]);
  assert.deepEqual(paths['/voice/twilio/incoming/{agentId}'].post.security, [{ twilioSignature: [] }]);
  assert.equal(paths['/voice/twilio/incoming/{agentId}'].post.requestBody.content['application/x-www-form-urlencoded'].schema.additionalProperties.type, 'string');
  assert.match(paths['/voice/twilio/incoming/{agentId}'].post.description,/TWILIO_SIP_URI/);
  assert.match(paths['/voice/twilio/incoming/{agentId}'].post.description,/VOICE_SIP_MICRO_USD_PER_MINUTE/);
  assert.ok(components.securitySchemes.twilioSignature);
  assert.match(paths['/voice/agent'].put.description, /CRM and calendar/);
  assert.match(paths['/voice/calls'].post.description, /15 minutes/);
});

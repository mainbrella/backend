import { ContainerPreviews } from './previews.js';
import { MAX_PROJECT_BINDINGS, validProjectBinding, validProjectId, validProjectRevision,
  validProjectOrigin, projectHeaders, projectResponseHeaders } from './project-contract.js';
import { boundedPrivateBody, validPrivateGeneration } from './private-services-contract.js';

const STORAGE_KEY = 'projectBindings';

// Private routing grants persist for the generation's paid running lease.
// Only the isolated gateway can select an origin; browser headers are stripped.
export class ContainerProjectIngress extends ContainerPreviews {
  async bindings(metadata) {
    return ((await this.controller.ctx.storage.get(STORAGE_KEY)) ?? [])
      .filter(binding => binding.createdAt === new Date(metadata.createdAt).toISOString());
  }

  async manage(request) {
    const c = this.controller;
    const url = new URL(request.url);
    if (!['GET', 'PUT', 'DELETE'].includes(request.method)) return c.respond({ error: 'method_not_allowed' }, 405);
    const id = url.searchParams.get('id'), revision = url.searchParams.get('revision'), origin = url.searchParams.get('origin');
    const createdAt = request.headers.get('x-project-created-at');
    if ([...url.searchParams.keys()].some(key => !['id', 'revision', 'origin'].includes(key))
      || [...new Set(url.searchParams.keys())].some(key => url.searchParams.getAll(key).length !== 1)
      || (request.method === 'DELETE' ? !validProjectId(id) || !validProjectRevision(revision) || !validPrivateGeneration(createdAt)
        || origin !== null && !validProjectOrigin(origin, this.allowLocal) : url.search !== '')) {
      return c.respond({ error: 'invalid_request' }, 400);
    }
    let body;
    if (request.method === 'PUT') {
      try { body = JSON.parse(new TextDecoder().decode(await boundedPrivateBody(request.body, 1024, request.signal))); }
      catch { return c.respond({ error: 'invalid_request' }, 400); }
      if (!validProjectBinding(body)) return c.respond({ error: 'invalid_request' }, 400);
    }
    return c.serialized(async () => {
      // Owner-scoped private cleanup must remain possible after a stop, lost
      // entitlement or slot replacement. Fence deletion against the persisted
      // generation rather than requiring that generation to still be live.
      if (request.method === 'DELETE') {
        const saved = (await c.ctx.storage.get(STORAGE_KEY)) ?? [];
        if (origin === null) await c.ctx.storage.put(STORAGE_KEY, saved.filter(binding =>
          binding.id !== id || binding.revision !== revision || binding.createdAt !== createdAt));
        for (const session of this.active) if (session.grant.project && session.grant.id === id
          && session.grant.revision === revision && session.grant.createdAt === createdAt
          && (origin === null || session.grant.origin === origin)) session.close('Project revoked');
        return c.respond({ revoked: true });
      }
      const metadata = await this.metadata(request.headers.get('x-project-created-at'));
      if (!metadata) return c.respond({ error: 'container_not_running' }, 409);
      const bindings = await this.bindings(metadata);
      if (request.method === 'GET') return c.respond({ bindings });
      const existing = bindings.find(binding => binding.id === body.id && binding.revision === body.revision);
      if (existing) return c.respond(existing.port === body.port ? existing : { error: 'revision_conflict' }, existing.port === body.port ? 200 : 409);
      if (bindings.length >= MAX_PROJECT_BINDINGS) return c.respond({ error: 'project_binding_limit' }, 429);
      const binding = { ...body, createdAt: new Date(metadata.createdAt).toISOString() };
      await c.ctx.storage.put(STORAGE_KEY, [...bindings, binding]);
      return c.respond(binding, 201);
    });
  }

  async forward(request) {
    const id = request.headers.get('x-project-id'), revision = request.headers.get('x-project-revision');
    const origin = request.headers.get('x-project-origin');
    if (!validProjectId(id) || !validProjectRevision(revision) || !validProjectOrigin(origin, this.allowLocal)) {
      return this.controller.respond({ error: 'project_unavailable' }, 403);
    }
    return this.forwardTransport(request, async () => {
      const metadata = await this.metadata(request.headers.get('x-project-created-at'));
      if (!metadata) return null;
      const binding = (await this.bindings(metadata)).find(binding => binding.id === id && binding.revision === revision);
      return binding ? { ...binding, project: true, origin, expiresAt: metadata.expiresAt } : null;
    }, '/project', origin, projectHeaders, projectResponseHeaders);
  }
}

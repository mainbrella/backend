import { z } from 'zod';
import { FETCH_LIMITS, fetchInput } from '../bff/fetch';
import { OG_IMAGE_TIMEOUT_MS, ogImageInput } from '../bff/og-image';
import { PREVIEW_LIMITS } from '../bff/previews';
import { errors, jsonResponse, register, requestBody, type LegacyHandler, type OpenAPIApi } from './openapi-shared';

export function registerBffFetchRoutes(api: OpenAPIApi, handler: LegacyHandler) {
  const previewSecurity: Record<string, string[]>[] = [{ cookieAuth: [] }, { apiKeyBearer: [] }, { bffApiKey: [], bffUserSession: [] }];
  const previewResult = z.object({
    image: z.string().url().nullable(), source: z.enum(['og', 'twitter', 'screenshot', 'favicon', 'placeholder']).optional(),
    status: z.enum(['ready', 'pending', 'failed']).optional(), previewId: z.string().uuid().optional(), statusUrl: z.string().url().optional(),
  });
  const queuedResult = previewResult.required({ source: true, status: true, previewId: true, statusUrl: true });
  const pendingResponse = { ...jsonResponse(queuedResult, 'Screenshot queued or processing; image is a favicon or null for a client placeholder.'),
    headers: { 'Retry-After': { schema: { type: 'integer' as const, minimum: 1 }, description: 'Seconds to wait before polling status.' } } };
  register(api, 'post', '/bff/fetch', {
    tags: ['BFF'], operationId: 'fetchBffUrl', summary: 'Fetch a public URL with a custom User-Agent',
    security: [{ cookieAuth: [] }, { apiKeyBearer: [] }],
    description: `Requires BFF_ENABLED and a Mainbrella session cookie or account API key (mb_ prefix). Browser calls require a trusted Mainbrella Origin. Invalid explicit credentials never fall back to cookies. Performs an upstream GET without forwarding caller credentials. Accepts public HTTP(S) URLs on default ports, without credentials or fragments; private IP literals and local/reserved hostnames are rejected on every redirect. Follows up to ${FETCH_LIMITS.redirects} redirects within one ${FETCH_LIMITS.timeoutMs / 1000}-second deadline, including body reads. Reads at most ${FETCH_LIMITS.responseBytes} body bytes. Returns HTTP 200 with the upstream status, headers and body in JSON, including upstream 4xx/5xx replies. responseType defaults to UTF-8 text; base64 preserves binary bytes. Upstream cookies and HTML are returned as data. Responses are not cached. No project or database provisioning is needed. Scoped project browser keys do not authorize this service.`,
    request: requestBody(fetchInput),
    responses: {
      200: jsonResponse(z.object({
        url: z.string().url(), status: z.number().int().min(100).max(599), statusText: z.string(),
        ok: z.boolean(), redirected: z.boolean(), headers: z.record(z.string(), z.string()),
        body: z.string(), bodyEncoding: z.enum(['text', 'base64']),
      })),
      ...errors(400, 401, 403, 405, 413, 415, 502, 503),
      408: jsonResponse(z.object({ error: z.literal('fetch_aborted') }), 'The caller canceled the request.'),
      504: jsonResponse(z.object({ error: z.literal('fetch_timeout') }), 'The upstream request or body exceeded the shared deadline.'),
    },
  }, handler);
  register(api, 'post', '/bff/og-image', {
    tags: ['BFF'], operationId: 'getBffOgImage', summary: 'Find a page’s Open Graph or Twitter preview image',
    security: previewSecurity,
    description: `Requires BFF_ENABLED. Owner calls use the same Mainbrella session or account API key and trusted Mainbrella Origin rules as /bff/fetch. Project-user calls must send both apikey: bff_pk_... and Authorization: Bearer bff_us_...; the project is inferred from the key. The key must have a live grant for its matching project owner, and its Origin must match a configured allowed origin when supplied. The project must be ready, unpaused, and unblocked, and the session must be live, unexpired, and belong to the same project. A browser key by itself is insufficient; revoked credentials and project mismatches are rejected. Explicit project credentials do not fall back to an account cookie. Project authorization requires the control database; projects that are not ready return 409 database_not_ready. The service does not require a project table-operation grant. Browser preflights allow origins configured on a live scoped key; the actual request rechecks its own key's allowed origins. Project frontends should omit cookies. Fetches HTML with Accept: text/html and User-Agent: MainbrellaPreviewBot/1.0. HTMLRewriter reads until the first og:image, the body element, or end of stream, then cancels the reader. Prefers the first og:image and falls back to the first twitter:image. Resolves relative image URLs against the final page URL after redirects. Returns an HTTP(S) image URL or null when none is found. One ${OG_IMAGE_TIMEOUT_MS / 1000}-second deadline covers redirects and parsing; reads at most ${FETCH_LIMITS.responseBytes} bytes. Upstream non-success replies return 502 with an upstream_http_STATUS error code. Responses are not cached. Owner calls need no project or database provisioning.`,
    request: requestBody(ogImageInput.describe(`Without projectId, retain metadata-only behavior. With projectId, authorize that project and enable queued screenshot fallback. Scoped callers must use the same project as their key and session. Metadata images always win. Missing metadata or an upstream fetch failure queues a Browser Run snapshot with a 1200x630 viewport, JPEG quality 80 and fullPage=false. Returns 202 with previewId and statusUrl; poll that URL using the same credentials. Cached screenshots are reused for ${PREVIEW_LIMITS.cacheMs / 86400_000} days. Browser failures return a favicon when supplied by page metadata, or image=null with source=placeholder. source and status are included for project-scoped requests. Storage uses the existing account R2 metering and funding rules under products/bff/<owner>/<projectId>/previews/.`)),
    responses: {
      200: jsonResponse(previewResult),
      202: pendingResponse,
      ...errors(400, 401, 403, 405, 409, 413, 415, 429, 502, 503),
      408: jsonResponse(z.object({ error: z.literal('fetch_aborted') }), 'The caller canceled the request.'),
      504: jsonResponse(z.object({ error: z.literal('fetch_timeout') }), 'The upstream request or HTML parsing exceeded the shared deadline.'),
    },
  }, handler);
  register(api, 'get', '/bff/projects/{projectId}/previews/{previewId}', {
    tags: ['BFF'], operationId: 'getBffPreviewStatus', summary: 'Poll a queued project preview screenshot',
    security: previewSecurity,
    description: 'Uses the same owner or scoped key plus live project session authentication as /bff/og-image. Scoped credentials must match projectId. Returns 202 while queued or processing, then 200 with a screenshot URL or a favicon/placeholder after failure. Screenshot URLs are unguessable public bearer links; anyone with the URL can load the cached JPEG without account credentials. Expired previews return 404. Responses are not cached.',
    request: { params: z.object({ projectId: z.string().uuid(), previewId: z.string().uuid() }) },
    responses: { 200: jsonResponse(queuedResult), 202: pendingResponse, ...errors(401, 403, 404, 405, 409, 503) },
  }, handler);
  register(api, 'get', '/bff/preview-images/{previewId}.jpg', {
    tags: ['BFF'], operationId: 'getBffPreviewImage', summary: 'Load a cached project preview JPEG using its public bearer URL',
    security: [],
    description: 'The random previewId is a bearer capability issued only after an authorized project request. Anyone possessing this URL can load the image in an img element. Never accepts R2 keys. Requires a live, unpaused, unblocked project and an unexpired ready preview. GET and HEAD are supported. Returns image/jpeg with nosniff and a cache lifetime of at most one hour, capped by expiry.',
    request: { params: z.object({ previewId: z.string().uuid() }) },
    responses: {
      200: { description: 'Cached 1200x630 JPEG.', content: { 'image/jpeg': { schema: z.string().openapi({ format: 'binary' }) } } },
      404: { description: 'Unknown, unavailable or expired image.' },
      405: { description: 'Use GET or HEAD.' }, 503: { description: 'Storage unavailable.' },
    },
  }, handler);
}

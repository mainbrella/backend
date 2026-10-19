import { z } from 'zod';
import { FETCH_LIMITS, fetchInput } from '../bff/fetch';
import { OG_IMAGE_TIMEOUT_MS, ogImageInput } from '../bff/og-image';
import { errors, jsonResponse, register, requestBody, type LegacyHandler, type OpenAPIApi } from './openapi-shared';

export function registerBffFetchRoutes(api: OpenAPIApi, handler: LegacyHandler) {
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
    security: [{ cookieAuth: [] }, { apiKeyBearer: [] }],
    description: `Uses the same authentication, origin restrictions, public URL validation and redirect limit as /bff/fetch. Requires BFF_ENABLED. Fetches HTML with Accept: text/html and User-Agent: MainbrellaPreviewBot/1.0. HTMLRewriter reads until the first og:image, the body element, or end of stream, then cancels the reader. Prefers the first og:image and falls back to the first twitter:image. Resolves relative image URLs against the final page URL after redirects. Returns an HTTP(S) image URL or null when none is found. One ${OG_IMAGE_TIMEOUT_MS / 1000}-second deadline covers redirects and parsing; reads at most ${FETCH_LIMITS.responseBytes} bytes. Upstream non-success replies return 502 with an upstream_http_STATUS error code. Responses are not cached. No project or database provisioning is needed.`,
    request: requestBody(ogImageInput),
    responses: {
      200: jsonResponse(z.object({ image: z.string().url().nullable() })),
      ...errors(400, 401, 403, 405, 413, 415, 502, 503),
      408: jsonResponse(z.object({ error: z.literal('fetch_aborted') }), 'The caller canceled the request.'),
      504: jsonResponse(z.object({ error: z.literal('fetch_timeout') }), 'The upstream request or HTML parsing exceeded the shared deadline.'),
    },
  }, handler);
}

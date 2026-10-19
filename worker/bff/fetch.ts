import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { egressTarget } from '../../containers/security-contract.js';
import { boundedBody } from '../shared/bounded-body.js';
import { BffError } from './contracts';

export const FETCH_LIMITS = { requestBytes: 16_384, responseBytes: 5 * 1024 * 1024, timeoutMs: 15_000, redirects: 5 } as const;
export const fetchUrlInput = z.string().min(1).max(8192).refine(value => egressTarget(value) !== null)
  .describe('Public HTTP(S) URL on its default port, without credentials or a fragment. Private IP literals and local/reserved hostnames are rejected.');
export const fetchInput = z.object({
  url: fetchUrlInput,
  userAgent: z.string().min(1).max(1024).regex(/^[\x20-\x7e]+$/).refine(value => value.trim().length > 0)
    .describe('User-Agent sent to the upstream server; printable ASCII only.'),
  responseType: z.enum(['text', 'base64']).default('text')
    .describe('Decode the body as UTF-8 text, or use base64 to preserve binary bytes.'),
}).strict();

const redirects = new Set([301, 302, 303, 307, 308]);

export async function fetchPublicUrl<T>(url: string,
  options: { headers: HeadersInit; timeoutMs: number; signal?: AbortSignal },
  consume: (response: Response, url: URL, redirected: boolean, signal: AbortSignal) => Promise<T>,
  fetcher: typeof fetch = fetch,
) {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let target = egressTarget(url);
  if (!target) throw new BffError('invalid_request');
  try {
    for (let hop = 0; ; hop++) {
      signal.throwIfAborted();
      // Build a fresh GET: caller cookies, authorization and other headers never
      // reach the upstream, including when a redirect changes the origin.
      const upstream = await fetcher(target.href, {
        method: 'GET', headers: options.headers,
        redirect: 'manual', credentials: 'omit', cache: 'no-store', signal,
      });
      const location = upstream.headers.get('location');
      if (redirects.has(upstream.status) && location !== null) {
        void upstream.body?.cancel().catch(() => {});
        if (hop >= FETCH_LIMITS.redirects) throw new BffError('too_many_redirects', 502);
        let next;
        try { next = egressTarget(new URL(location, target).href); }
        catch { /* Reject malformed redirect destinations below. */ }
        if (!next) throw new BffError('upstream_redirect_not_allowed', 502);
        target = next;
        continue;
      }
      try { return await consume(upstream, target, hop > 0, signal); }
      finally {
        if (upstream.body && !upstream.body.locked) void upstream.body.cancel().catch(() => {});
      }
    }
  } catch (error) {
    if (error instanceof BffError) throw error;
    if (options.signal?.aborted) throw new BffError('fetch_aborted', 408);
    if (timeout.aborted) throw new BffError('fetch_timeout', 504);
    throw new BffError('fetch_failed', 502);
  }
}

export async function fetchUrl(input: z.infer<typeof fetchInput>, requestSignal?: AbortSignal, fetcher: typeof fetch = fetch) {
  return fetchPublicUrl(input.url, { headers: { 'User-Agent': input.userAgent }, timeoutMs: FETCH_LIMITS.timeoutMs, signal: requestSignal },
    async (upstream, target, redirected, signal) => {
      let bytes;
      try { bytes = await boundedBody(upstream.body, FETCH_LIMITS.responseBytes, signal); }
      catch (error) {
        if (error instanceof Error && error.message === 'request_too_large') throw new BffError('response_too_large', 413);
        throw error;
      }
      return {
        url: target.href, status: upstream.status, statusText: upstream.statusText,
        ok: upstream.ok, redirected, headers: Object.fromEntries(upstream.headers),
        body: input.responseType === 'base64' ? Buffer.from(bytes ?? []).toString('base64') : new TextDecoder().decode(bytes),
        bodyEncoding: input.responseType,
      };
    }, fetcher);
}

import { z } from 'zod';
import { BffError } from './contracts';
import { FETCH_LIMITS, fetchPublicUrl, fetchUrlInput } from './fetch';

export const OG_IMAGE_TIMEOUT_MS = 8000;
export const ogImageInput = z.object({ url: fetchUrlInput }).strict();

function imageUrl(content: string, target: URL): string | null {
  // HTMLRewriter exposes raw attribute values, including escaped ampersands.
  const entities: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
  const decoded = content.replace(/&(?:#(\d+)|#x([a-f\d]+)|(amp|quot|apos|lt|gt));/gi, (original, decimal, hex, named) => {
    if (named) return entities[named.toLowerCase()];
    const point = parseInt(decimal || hex, decimal ? 10 : 16);
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : original;
  });
  try {
    const resolved = new URL(decoded, target);
    return ['http:', 'https:'].includes(resolved.protocol) && !resolved.username && !resolved.password ? resolved.href : null;
  } catch { return null; }
}

export async function getOgImage(url: string, requestSignal?: AbortSignal): Promise<string | null> {
  return fetchPublicUrl(url, {
    headers: { Accept: 'text/html', 'User-Agent': 'MainbrellaPreviewBot/1.0' },
    timeoutMs: OG_IMAGE_TIMEOUT_MS, signal: requestSignal,
  }, async (response, target, _redirected, signal) => {
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new BffError(`upstream_http_${response.status}`, 502);
    }
    if (!response.body) return null;
    let ogImage: string | null = null, twitterImage: string | null = null, bodyReached = false, bytes = 0;
    const bounded = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > FETCH_LIMITS.responseBytes) throw new BffError('response_too_large', 413);
        controller.enqueue(chunk);
      },
    }));
    const parsed = new HTMLRewriter()
      .on('meta', {
        element(el) {
          if (bodyReached) return;
          const name = (el.getAttribute('property') || el.getAttribute('name') || '').toLowerCase();
          const content = el.getAttribute('content')?.trim();
          if (name === 'og:image' && content) ogImage ??= imageUrl(content, target);
          if (name === 'twitter:image' && content) twitterImage ??= imageUrl(content, target);
        },
      })
      .on('body', { element() { bodyReached = true; } })
      .transform(new Response(bounded, { headers: response.headers }));
    const reader = parsed.body!.getReader();
    const onAbort = () => { void reader.cancel(signal.reason).catch(() => {}); };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      signal.throwIfAborted();
      for (;;) {
        const { done } = await reader.read();
        signal.throwIfAborted();
        if (done || bodyReached || ogImage) break;
      }
    } catch (error) {
      // The native rewriter may wrap an upstream stream error.
      if (bytes > FETCH_LIMITS.responseBytes) throw new BffError('response_too_large', 413);
      throw error;
    } finally {
      signal.removeEventListener('abort', onAbort);
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    return ogImage || twitterImage;
  });
}

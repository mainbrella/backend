// Preview ingress is restricted to application ports. Privileged/control ports,
// including SSH, are never eligible even when an image listens on them.
export const MIN_PREVIEW_PORT = 1024;
export const MAX_PREVIEW_PORT = 65535;
export const MAX_PREVIEW_GRANTS = 8;
export const MAX_PREVIEW_CONNECTIONS = 16;
export const DEFAULT_PREVIEW_TTL_SECONDS = 900;
export const MAX_PREVIEW_TTL_SECONDS = 3600;
export const PREVIEW_CONNECT_TIMEOUT_MS = 15_000;
export const MAX_PREVIEW_FRAME_BYTES = 1024 * 1024;
export const validPreviewPort = port => Number.isInteger(port) && port >= MIN_PREVIEW_PORT && port <= MAX_PREVIEW_PORT;
export const validPreviewToken = token => typeof token === 'string' && /^[a-f0-9]{48}$/.test(token);
export const validPreviewId = id => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
export function validPreviewOptions(body) {
  return Boolean(body && typeof body === 'object' && !Array.isArray(body)
    && Object.keys(body).every(key => ['port', 'ttlSeconds'].includes(key))
    && validPreviewPort(body.port)
    && (body.ttlSeconds === undefined || Number.isInteger(body.ttlSeconds)
      && body.ttlSeconds >= 60 && body.ttlSeconds <= MAX_PREVIEW_TTL_SECONDS));
}

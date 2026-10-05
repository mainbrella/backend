// Shared by the public API and private runtime; neither trusts client options.
export const MAX_COMMAND_BYTES = 16 * 1024;
export const MAX_REQUEST_BYTES = 32 * 1024;
export const MAX_OUTPUT_BYTES = 1024 * 1024;
export const MAX_TIMEOUT_MS = 60_000;
export const MAX_EXECUTIONS = 4;
const encoder = new TextEncoder();

export function validCommand(body) {
  return body && typeof body === 'object' && !Array.isArray(body)
    && Object.keys(body).every(key => ['command', 'timeoutMs'].includes(key))
    && typeof body.command === 'string' && body.command.trim().length > 0
    && !body.command.includes('\0') && encoder.encode(body.command).byteLength <= MAX_COMMAND_BYTES
    && (body.timeoutMs === undefined || (Number.isInteger(body.timeoutMs)
      && body.timeoutMs >= 1 && body.timeoutMs <= MAX_TIMEOUT_MS));
}

export async function readCommandBody(request) {
  if (!request.body) throw new Error('invalid_request');
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) throw new Error('request_too_large');
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

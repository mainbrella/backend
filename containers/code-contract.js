import { MAX_COMMAND_BYTES, MAX_TIMEOUT_MS } from './command-contract.js';

export const MAX_CODE_CONTEXT_MS = 15 * 60_000;
export const MAX_CODE_RESULT_BYTES = 256 * 1024;
export const validCodeContextId = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
export function validCodeContext(body) {
  return body && typeof body === 'object' && !Array.isArray(body)
    && Object.keys(body).every(key => key === 'language') && body.language === 'python';
}
export function validCodeExecution(body) {
  return body && typeof body === 'object' && !Array.isArray(body)
    && Object.keys(body).every(key => ['code', 'timeoutMs'].includes(key))
    && typeof body.code === 'string' && body.code.trim().length > 0
    && !body.code.includes('\0') && new TextEncoder().encode(body.code).byteLength <= MAX_COMMAND_BYTES
    && (body.timeoutMs === undefined || Number.isInteger(body.timeoutMs) && body.timeoutMs >= 1 && body.timeoutMs <= MAX_TIMEOUT_MS);
}

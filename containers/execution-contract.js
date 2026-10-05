import { MAX_COMMAND_BYTES } from './command-contract.js';
export const MAX_MANAGED_TIMEOUT_MS = 15 * 60_000;
export const EXECUTION_RETENTION_MS = 60 * 60_000;
export const MAX_RETAINED_EXECUTIONS = 32;
export const MAX_EXECUTION_EVENTS = 512;
export const MAX_EXECUTION_STREAMS = 8;
export const EXECUTION_STREAM_MS = 30_000;
export const validExecutionId = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export const terminalExecution = record => record.status !== 'starting' && record.status !== 'running';
export function validExecution(body) {
  return body && typeof body === 'object' && !Array.isArray(body)
    && Object.keys(body).every(key => ['command', 'timeoutMs'].includes(key))
    && typeof body.command === 'string' && body.command.trim().length > 0 && !body.command.includes('\0')
    && new TextEncoder().encode(body.command).byteLength <= MAX_COMMAND_BYTES
    && (body.timeoutMs === undefined || Number.isInteger(body.timeoutMs) && body.timeoutMs >= 1 && body.timeoutMs <= MAX_MANAGED_TIMEOUT_MS);
}

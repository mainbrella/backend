import { MAX_COMMAND_BYTES } from './command-contract.js';
import { validFilesystemPath } from './filesystem-contract.js';
export const MAX_MANAGED_TIMEOUT_MS = 15 * 60_000;
export const EXECUTION_RETENTION_MS = 60 * 60_000;
export const MAX_RETAINED_EXECUTIONS = 32;
export const MAX_EXECUTION_EVENTS = 512;
export const MAX_EXECUTION_STREAMS = 8;
export const EXECUTION_STREAM_MS = 30_000;
export const MAX_STDIN_CHUNK_BYTES = 64 * 1024;
export const MAX_STDIN_BYTES = 1024 * 1024;
export const MAX_PENDING_STDIN_BYTES = 256 * 1024;
export const EXECUTION_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGKILL'];
export const validTerminalSize = value => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === 2 && ['cols', 'rows'].every(key => Number.isInteger(value[key]) && value[key] >= 1 && value[key] <= 1000);
export const validExecutionId = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export const terminalExecution = record => record.status !== 'starting' && record.status !== 'running';
export function validExecution(body) {
  return body && typeof body === 'object' && !Array.isArray(body)
    && Object.keys(body).every(key => ['command', 'argv', 'timeoutMs', 'stdin', 'cwd', 'env', 'pty'].includes(key))
    && (typeof body.command === 'string' && body.command.trim().length > 0 && !body.command.includes('\0')
      && body.argv === undefined && new TextEncoder().encode(body.command).byteLength <= MAX_COMMAND_BYTES
      || body.command === undefined && Array.isArray(body.argv) && body.argv.length > 0 && body.argv.length <= 64
      && body.argv.every(value => typeof value === 'string' && !value.includes('\0')) && body.argv[0].length > 0
      && new TextEncoder().encode(body.argv.join('\0')).byteLength <= MAX_COMMAND_BYTES)
    && (body.timeoutMs === undefined || Number.isInteger(body.timeoutMs) && body.timeoutMs >= 1 && body.timeoutMs <= MAX_MANAGED_TIMEOUT_MS)
    && (body.stdin === undefined || typeof body.stdin === 'boolean')
    && (body.pty === undefined || validTerminalSize(body.pty) && body.stdin === true)
    && (body.cwd === undefined || validFilesystemPath(body.cwd, true))
    && (body.env === undefined || body.env && typeof body.env === 'object' && !Array.isArray(body.env)
      && Object.keys(body.env).length <= 64 && Object.entries(body.env).every(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)
        && typeof value === 'string' && !value.includes('\0') && new TextEncoder().encode(value).byteLength <= 4096)
      && new TextEncoder().encode(JSON.stringify(body.env)).byteLength <= 16 * 1024);
}

export function executionFingerprintValues(body) {
  const base = [body.command ?? body.argv, body.timeoutMs ?? 30_000];
  const env = Object.entries(body.env ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  // Preserve legacy fingerprints when the new options are not used.
  if (body.stdin || body.cwd !== undefined || env.length) base.push(Boolean(body.stdin), body.cwd ?? null, env);
  if (body.pty) base.push([body.pty.cols, body.pty.rows]);
  return base;
}

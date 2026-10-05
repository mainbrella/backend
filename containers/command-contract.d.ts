export const MAX_COMMAND_BYTES: number;
export const MAX_REQUEST_BYTES: number;
export const MAX_OUTPUT_BYTES: number;
export const MAX_TIMEOUT_MS: number;
export const MAX_EXECUTIONS: number;
export type Command = { command: string; timeoutMs?: number };
export function validCommand(body: unknown): body is Command;
export function readCommandBody(request: Request): Promise<unknown>;

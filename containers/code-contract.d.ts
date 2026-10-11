export const MAX_CODE_CONTEXT_MS: number;
export const MAX_CODE_RESULT_BYTES: number;
export function validCodeContextId(value: unknown): value is string;
export function validCodeContext(body: unknown): body is { language: 'python' };
export function validCodeExecution(body: unknown): body is { code: string; timeoutMs?: number };

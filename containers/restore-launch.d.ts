export const MAX_WORKSPACE_REQUEST_BYTES: number;
export const MAX_RESTORE_LOG_BYTES: number;
export interface RestoreLaunch { command: string; cwd: string; readiness: { port: number; path: string; timeoutMs: number } }
export interface RestoreReadiness { status: 'starting' | 'ready' | 'failed'; port: number; path: string; logPath: string; checkedAt?: string; error?: string; logTail?: string }
export function normalizeRestoreLaunch(value: unknown): RestoreLaunch | null;
export function restoreEntrypoint(launch: RestoreLaunch, logPath: string): string[];
export function publicRestoreReadiness(readiness: RestoreReadiness | undefined): RestoreReadiness | undefined;
export function observeRestoreReadiness(controller: any, original: any): Promise<void>;

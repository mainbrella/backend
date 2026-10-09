export const PRODUCTION_LEASE_MS: number;
export const PRODUCTION_POLL_MS: number;
export const PRODUCTION_INACTIVITY_MS: number;
export function validLifecycle(value: unknown): value is 'ad_hoc' | 'production';
export function validStartupCommand(value: unknown): value is string;
export function productionEntrypoint(command: string, logPath?: string): string[];

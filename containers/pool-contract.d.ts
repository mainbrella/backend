export const MAX_MANAGED_POOLS: number;
export const MAX_POOL_SIZE: number;
export const MIN_POOL_TTL_SECONDS: number;
export const MAX_POOL_TTL_SECONDS: number;
export const POOL_POLL_MS: number;
export const POOL_OPERATION_RETENTION_MS: number;
export function validPoolId(id: unknown): boolean;
export function validPoolSize(size: unknown): boolean;
export function validPoolTTL(seconds: unknown): boolean;

export const MAX_MANAGED_POOLS = 8;
export const MAX_POOL_SIZE = 20;
export const MIN_POOL_TTL_SECONDS = 60;
export const MAX_POOL_TTL_SECONDS = 86400;
export const POOL_POLL_MS = 30000;
export const POOL_OPERATION_RETENTION_MS = 86400000;
export const validPoolId = id => typeof id === 'string' && /^pool_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id);
export const validPoolSize = size => Number.isInteger(size) && size >= 0 && size <= MAX_POOL_SIZE;
export const validPoolTTL = seconds => Number.isInteger(seconds) && seconds >= MIN_POOL_TTL_SECONDS && seconds <= MAX_POOL_TTL_SECONDS;

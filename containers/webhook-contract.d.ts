export const MAX_WEBHOOK_CONFIGS: number;
export const MAX_WEBHOOK_DELIVERIES: number;
export const WEBHOOK_ATTEMPTS: number;
export const WEBHOOK_RETRY_MS: number[];
export const WEBHOOK_BODY_BYTES: number;
export function readWebhookBody(request: Request): Promise<unknown>;
export function webhookUrl(value: unknown, allowlist?: string): string | null;
export function webhooksConfigured(env: { WORKLOAD_WEBHOOKS_ENABLED?: string; WEBHOOK_ALLOWED_HOSTS?: string }): boolean;

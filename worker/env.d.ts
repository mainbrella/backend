// Legacy application modules support these optional integrations. Keep their
// declarations separate from Wrangler's generated deployment bindings.
interface Env {
  WORKSPACE_PERSISTENCE_ENABLED?: string;
  NETWORK_INTERNET_CONTROL_ENABLED?: string;
  WORKLOAD_WEBHOOKS_ENABLED?: string;
  WEBHOOK_ALLOWED_HOSTS?: string;
  WORKLOAD_METRICS_ENABLED?: string;
  WORKLOAD_METRICS_ACCOUNT_ID?: string;
  WORKLOAD_METRICS_TOKEN?: string;
  PREVIEWS_ENABLED?: string;
  PREVIEW_DOMAIN?: string;
  PREVIEW_ROUTES?: D1Database;
  MONITORING_SECRET?: string;
  IMAGE_BUILD_GITHUB_TOKEN?: string;
  IMAGE_BUILD_SECRET?: string;
  SUPABASE_URL?: string;
  BUCKET?: R2Bucket;
  ANONYMOUS_SIGNUP_LIMIT?: RateLimit;
  APP_STATE?: DurableObjectNamespace;
}

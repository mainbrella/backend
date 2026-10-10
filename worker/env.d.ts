// Legacy application modules support these optional integrations. Keep their
// declarations separate from Wrangler's generated deployment bindings.
interface Env {
  STRIPE_PREPAID_PRICE_ID?: string;
  LOCAL_DEV?: string;
  LOCAL_PREVIEW_PORT?: string;
  ACTIVITY_WEBSOCKET_ENABLED?: string;
  WORKSPACE_PERSISTENCE_ENABLED?: string;
  NETWORK_INTERNET_CONTROL_ENABLED?: string;
  PRIVATE_SERVICES_ENABLED?: string;
  WORKLOAD_WEBHOOKS_ENABLED?: string;
  WEBHOOK_ALLOWED_HOSTS?: string;
  WORKLOAD_METRICS_ENABLED?: string;
  WORKLOAD_METRICS_ACCOUNT_ID?: string;
  WORKLOAD_METRICS_TOKEN?: string;
  PREVIEWS_ENABLED?: string;
  PREVIEW_DOMAIN?: string;
  PREVIEW_ROUTES?: D1Database;
  PROJECT_HOSTING_ENABLED?: string;
  PROJECT_DOMAIN_PROVIDER?: string;
  PROJECT_CLOUDFLARE_ZONE_ID?: string;
  PROJECT_CLOUDFLARE_API_TOKEN?: string;
  PROJECT_APEX_IPS?: string;
  PROJECT_INGRESS_HOST?: string;
  PROJECT_INGRESS_SECRET?: string;
  MONITORING_SECRET?: string;
  REPO_RUN_GITHUB_TOKEN?: string;
  IMAGE_BUILD_GITHUB_TOKEN?: string;
  IMAGE_BUILD_SECRET?: string;
  SUPABASE_URL?: string;
  BUCKET?: R2Bucket;
  ANONYMOUS_SIGNUP_LIMIT?: RateLimit;
  APP_STATE?: DurableObjectNamespace;
}

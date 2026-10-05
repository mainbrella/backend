// Legacy application modules support these optional integrations. Keep their
// declarations separate from Wrangler's generated deployment bindings.
interface Env {
  MONITORING_SECRET?: string;
  IMAGE_BUILD_GITHUB_TOKEN?: string;
  IMAGE_BUILD_SECRET?: string;
  SUPABASE_URL?: string;
  BUCKET?: R2Bucket;
  ANONYMOUS_SIGNUP_LIMIT?: RateLimit;
  APP_STATE?: DurableObjectNamespace;
}

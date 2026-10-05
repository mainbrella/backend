// Legacy application modules support these optional integrations. Keep their
// declarations separate from Wrangler's generated deployment bindings.
interface Env {
  SUPABASE_URL?: string;
  BUCKET?: R2Bucket;
  ANONYMOUS_SIGNUP_LIMIT?: RateLimit;
  APP_STATE?: DurableObjectNamespace;
}

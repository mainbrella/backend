import {
  AuthError,
  authJson,
  createSession,
  findOrCreateGoogleUser,
  findOrCreateReviewUser,
  publicUser,
  readJSON,
  verifyGoogleIdToken,
  type StringHeaders,
} from "./auth-core";
import { issueAppTokens } from "./auth-app";
import { absorbAnonymousHerds } from "./auth-anonymous";
import { signInOrCreateEmailUser } from "./auth-email";

const REVIEW_LOGIN_EMAIL = "test@andrewarrow.dev";
const REVIEW_LOGIN_PASSWORD = "testing";

export async function handleGoogleLogin(
  request: Request,
  env: Env,
  corsHeaders: StringHeaders,
): Promise<Response> {
  const body = await readJSON(request, 20_000);
  if (!body) return authJson({ error: "invalid_request" }, 400, corsHeaders);

  try {
    const identity = await verifyGoogleIdToken(body.credential, env);
    const { user, created } = await findOrCreateGoogleUser(env, identity);
    return authJson(
      { user: publicUser(user), created },
      200,
      { ...corsHeaders, "set-cookie": await createSession(env, user.id) },
    );
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 500;
    if (status >= 500) console.error("google_login_error", error);
    return authJson(
      { error: status === 500 ? "auth_unavailable" : status === 503 ? "google_unavailable" : status === 409 ? "identity_conflict" : "invalid_google_credential" },
      status,
      corsHeaders,
    );
  }
}

export async function handleEmailLogin(
  request: Request,
  env: Env,
  corsHeaders: StringHeaders,
): Promise<Response> {
  try {
    const body = await readJSON(request, 2_000);
    if (!body) return authJson({ error: "invalid_request" }, 400, corsHeaders);
    const { user, created } = await signInOrCreateEmailUser(env, body.email, body.password);
    return authJson(
      { user: publicUser(user), created },
      200,
      { ...corsHeaders, "set-cookie": await createSession(env, user.id) },
    );
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 503;
    if (status >= 500) console.error("email_login_error", error);
    return authJson({ error: error instanceof AuthError ? error.message : "auth_unavailable" }, status, corsHeaders);
  }
}

export async function handleNativeGoogleLogin(
  request: Request,
  env: Env,
  corsHeaders: StringHeaders,
): Promise<Response> {
  const body = await readJSON(request, 20_000);
  if (!body) return authJson({ error: "invalid_request" }, 400, corsHeaders);
  try {
    const identity = await verifyGoogleIdToken(body.credential, env);
    const { user } = await findOrCreateGoogleUser(env, identity);
    await absorbAnonymousHerds(env, request, user.id);
    return authJson(await issueAppTokens(env, user), 200, corsHeaders);
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 500;
    if (status >= 500) console.error("native_google_login_error", error);
    return authJson({ error: status === 503 ? "google_unavailable" : status === 409 ? "identity_conflict" : status === 401 ? "invalid_google_credential" : "auth_unavailable" }, status, corsHeaders);
  }
}

export async function handleNativeEmailLogin(
  request: Request,
  env: Env,
  corsHeaders: StringHeaders,
): Promise<Response> {
  const body = await readJSON(request, 2_000);
  if (!body || typeof body.email !== "string" || typeof body.password !== "string") {
    return authJson({ error: "invalid_request" }, 400, corsHeaders);
  }
  if (body.email.trim().toLowerCase() !== REVIEW_LOGIN_EMAIL || body.password !== REVIEW_LOGIN_PASSWORD) {
    return authJson({ error: "invalid_credentials" }, 401, corsHeaders);
  }
  try {
    const user = await findOrCreateReviewUser(env, REVIEW_LOGIN_EMAIL);
    await absorbAnonymousHerds(env, request, user.id);
    return authJson(await issueAppTokens(env, user), 200, corsHeaders);
  } catch (error) {
    console.error("native_email_login_error", error);
    return authJson({ error: "auth_unavailable" }, 503, corsHeaders);
  }
}

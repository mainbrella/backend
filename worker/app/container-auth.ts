import { apiKeyUser } from "./api-keys";
import { currentUser, sessionUser } from "./auth-core";

// Automation accepts API keys or login sessions on lifecycle, image and SSH routes.
// An explicit invalid Bearer credential must never fall back to a browser cookie.
export async function containerUser(env: Env, request: Request) {
  const authorization = request.headers.get("Authorization");
  if (authorization !== null) {
    const apiKey = authorization.match(/^Bearer (mb_[a-f0-9]{64})$/i)?.[1];
    if (apiKey) return apiKeyUser(env, apiKey);
    const token = authorization.match(/^Bearer ([a-f0-9]{64})$/i)?.[1];
    return token ? sessionUser(env, token) : null;
  }
  return currentUser(env, request);
}

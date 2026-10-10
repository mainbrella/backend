import { BuildError } from './build-contract';
import type { BuildAIMessage } from './build-ai';

export function localCodexConfigured(env: Env) {
  return env.LOCAL_DEV === 'true' && Boolean(env.BUILD_CODEX_URL && env.BUILD_CODEX_TOKEN);
}

function sessionUrl(env: Env, sessionId: string) {
  const url = new URL(env.BUILD_CODEX_URL!);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) throw new BuildError('build_unavailable');
  return new URL(`/sessions/${encodeURIComponent(sessionId)}`, url);
}

export async function codexInference(env: Env, sessionId: string, messages: BuildAIMessage[], tools: unknown[], maxTokens: number) {
  try {
    const response = await fetch(sessionUrl(env, sessionId), { method: 'POST',
      headers: { Authorization: `Bearer ${env.BUILD_CODEX_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, tools, maxTokens }), signal: AbortSignal.timeout(245_000) });
    if (!response.ok || !response.body) throw new BuildError('build_unavailable');
    return response.body;
  } catch (error) {
    if (error instanceof BuildError) throw error;
    throw new BuildError('build_unavailable');
  }
}

export async function closeCodexInference(env: Env, sessionId: string) {
  if (!localCodexConfigured(env)) return;
  try {
    await fetch(sessionUrl(env, sessionId), { method: 'DELETE',
      headers: { Authorization: `Bearer ${env.BUILD_CODEX_TOKEN}` }, signal: AbortSignal.timeout(2000) });
  } catch { /* The bridge also expires abandoned sessions and cancels on shutdown. */ }
}

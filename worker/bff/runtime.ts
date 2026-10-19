import { BffError, LIMITS, type DatabasePrincipal, type FunctionVersion, type Project } from './contracts';

const wrapper = `import { WorkerEntrypoint } from 'cloudflare:workers';
import handler from './customer.js';
export default class extends WorkerEntrypoint {
  async run(input, db, user) {
    try {
      if (typeof handler !== 'function') throw new Error('Export a default function.');
      const value = await handler(input, Object.freeze({ db, user: user ? Object.freeze(user) : null }));
      return JSON.stringify({ ok: true, value: value === undefined ? null : value });
    } catch (error) {
      return JSON.stringify({ ok: false, error: String(error?.message || 'Function failed.').slice(0, 1000) });
    }
  }
}`;

export function workerCode(source: string): WorkerLoaderWorkerCode {
  return {
    compatibilityDate: '2026-10-01', mainModule: 'entry.js',
    modules: { 'entry.js': wrapper, 'customer.js': source },
    env: {}, globalOutbound: null,
    limits: { cpuMs: LIMITS.cpuMs, subRequests: LIMITS.databaseCalls + 1 },
  };
}

export async function executeFunction(env: Env, project: Project, fn: FunctionVersion, input: unknown, principal: DatabasePrincipal) {
  if (!env.BFF_LOADER) throw new BffError('function_runtime_unavailable', 503);
  // Import only in the Workers runtime; Node-based routing/schema tests never
  // need to emulate cloudflare:workers or substitute a weaker JS sandbox.
  const { DatabaseCapability } = await import('./capability');
  const capability = fn.database_access === 'none' ? null : new DatabaseCapability(env, project, fn.database_access, principal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Fresh isolate for every invocation, including globals and module state.
    const worker = env.BFF_LOADER.load(workerCode(fn.source));
    const entry = worker.getEntrypoint() as unknown as { run(input: unknown, db: unknown, user: { id: string } | null): Promise<string> };
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { capability?.close(); reject(new BffError('function_timeout', 408)); }, LIMITS.wallMs);
    });
    const output = await Promise.race([entry.run(input, capability, principal.role === 'user' ? { id: principal.userId } : null), timeout]);
    if (typeof output !== 'string' || new TextEncoder().encode(output).length > LIMITS.outputBytes) throw new BffError('function_result_too_large', 413);
    const result = JSON.parse(output) as { ok: boolean; value?: unknown; error?: string };
    if (typeof result?.ok !== 'boolean') throw new BffError('function_failed', 422);
    return result.ok ? { ok: true, value: result.value ?? null } : { ok: false, error: typeof result.error === 'string' ? result.error.slice(0, 1000) : 'Function failed.' };
  } catch (error) {
    if (error instanceof BffError) throw error;
    // Provider exceptions can include code or platform details. Keep them out of
    // customer responses and logs. Customer-thrown errors come from the wrapper.
    throw new BffError('function_failed', 422);
  } finally {
    clearTimeout(timer); capability?.close();
  }
}

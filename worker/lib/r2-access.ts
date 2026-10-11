import { storageMetered, storageRateLimit } from './r2-storage';

/** Expensive reads remain available without credit, under bounded request and
 * concurrent export limits. A lease is released on completion, cancellation,
 * or error; its TTL recovers clients that disappear without cancelling. */
export async function storageReadAccess(env: Env, userId: string, exportRequest: boolean, run: () => Promise<Response>, eventStream = false) {
  if (!storageMetered(env)) return run();
  await storageRateLimit(env, 'reads:global', 6000);
  await storageRateLimit(env, `reads:${userId}`, 120);
  if (!exportRequest && !eventStream) return run();
  const owner = eventStream ? `events:${userId}` : userId;
  await storageRateLimit(env, `${eventStream ? 'events' : 'exports'}:${userId}`, 6);
  const token = crypto.randomUUID(), now = Date.now();
  const lease = await env.DB.prepare(`INSERT INTO r2_export_leases(token,user_id,expires_at)
    SELECT ?,?,? WHERE (SELECT COUNT(*) FROM r2_export_leases WHERE user_id=? AND expires_at>?)<2
    AND (SELECT COUNT(*) FROM r2_export_leases WHERE expires_at>?)<100 RETURNING token`)
    .bind(token, owner, now + 15 * 60000, owner, now, now).first();
  if (!lease) throw new Error(eventStream ? 'storage_stream_busy' : 'storage_export_busy');
  const release = () => env.DB.prepare('DELETE FROM r2_export_leases WHERE token=?').bind(token).run();
  try {
    const response = await run();
    if (!response.body) { await release(); return response; }
    const reader = response.body.getReader();
    const deadline = now + 15 * 60000;
    const body = new ReadableStream({
      async pull(controller) {
        try {
          if (Date.now() >= deadline) throw new Error('storage_stream_timeout');
          const result = await reader.read();
          if (result.done) { await release(); controller.close(); }
          else controller.enqueue(result.value);
        } catch (error) {
          await reader.cancel(error).catch(() => {});
          try { await release(); } finally { controller.error(error); }
        }
      },
      async cancel(reason) { try { await reader.cancel(reason); } finally { await release(); } },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (error) { await release(); throw error; }
}

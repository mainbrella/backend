import type { BuildParams } from './build-contract';

export type BuildActivity = { id: string; type: 'message' | 'tool'; text: string; status: 'running' | 'succeeded' | 'failed' };
export type BuildActivityRow = BuildActivity & { turn_id: string };

export async function saveBuildActivity(env: Env, params: BuildParams, position: number, activity: BuildActivity) {
  // Stable IDs replace partial text and make replayed Workflow steps idempotent.
  await env.DB.prepare(`INSERT INTO build_activity (turn_id, id, position, type, text, status)
    SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM build_turns WHERE id = ? AND user_id = ? AND status IN ('queued', 'running'))
    ON CONFLICT(turn_id, id) DO UPDATE SET text = excluded.text, status = excluded.status`)
    .bind(params.turnId, activity.id, position, activity.type, activity.text.slice(0, 6000), activity.status, params.turnId, params.userId).run();
}

export function buildToolLabel(name: string, argumentsJSON: string) {
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(argumentsJSON); } catch {
    // A file path can arrive before the rest of a streamed write_file argument.
    args = { path: argumentsJSON.match(/"path"\s*:\s*"([^"\\]+)"/)?.[1] };
  }
  const path = typeof args?.path === 'string' ? args.path : 'source file';
  return ({ list_files: 'Inspect project files', read_file: `Read ${path}`, write_file: `Write ${path}`,
    delete_file: `Delete ${path}`, run_command: args?.command === 'npm install' ? 'Install dependencies' : 'Check the build',
    get_logs: 'Read build output', generate_image: `Generate ${typeof args?.label === 'string' ? args.label : 'original imagery'}` } as Record<string, string>)[name] || 'Update the app';
}

/** A bounded stream of durable snapshots. Reconnecting never restarts a build. */
export function buildAppStream(request: Request, read: () => Promise<{ app: { activeTurnId: string | null } }>, cors: Record<string, string>) {
  const encoder = new TextEncoder();
  let stopped = false;
  let wake: (() => void) | undefined;
  const stop = () => { stopped = true; wake?.(); };
  request.signal.addEventListener('abort', stop, { once: true });
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let previous = '';
      const deadline = Date.now() + 55_000;
      try {
        while (!stopped && !request.signal.aborted && Date.now() < deadline) {
          const snapshot = await read();
          if (stopped) break;
          const data = JSON.stringify(snapshot);
          if (data !== previous) { controller.enqueue(encoder.encode(`event: app\ndata: ${data}\n\n`)); previous = data; }
          else controller.enqueue(encoder.encode(': keep-alive\n\n'));
          if (!snapshot.app.activeTurnId) break;
          await new Promise<void>(resolve => {
            const timer = setTimeout(() => { wake = undefined; resolve(); }, 750);
            wake = () => { clearTimeout(timer); resolve(); };
          });
        }
        if (!stopped) controller.close();
      } catch {
        if (!stopped) controller.error(new Error('Build progress unavailable'));
      } finally {
        stop(); request.signal.removeEventListener('abort', stop);
      }
    },
    cancel: stop,
  });
  return new Response(stream, { headers: { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

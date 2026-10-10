import { validBuildPath, type BuildParams } from './build-contract';

export type BuildActivity = { id: string; type: 'message' | 'tool'; text: string; status: 'proposed' | 'running' | 'skipped' | 'blocked' | 'succeeded' | 'failed' | 'unknown'; explanation?: string | null };
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
    delete_file: `Delete ${path}`, run_command: args?.command === 'npm install' ? 'Install dependencies' : 'Type-check and compile',
    get_logs: 'Read build output', generate_image: `Generate ${typeof args?.label === 'string' ? args.label : 'original imagery'}` } as Record<string, string>)[name] || 'Update the app';
}

/** A public-only label for an incomplete write request; file contents stay private. */
export function buildToolDraftLabel(name: string, argumentsJSON: string) {
  if (name !== 'write_file') return buildToolLabel(name, argumentsJSON);
  const match = argumentsJSON.match(/"path"\s*:\s*"([^"\\]+)"/);
  const path = match?.[1] && validBuildPath(match[1]) && !match[1].startsWith('public/generated/') ? match[1] : 'source file';
  const content = argumentsJSON.match(/"content"\s*:\s*"/);
  if (!content) return `Drafting ${path}`;

  // Decode only enough of the partial JSON string to count characters and
  // logical line breaks. This never returns or persists any file text.
  let characters = 0, lineBreaks = 0, previousWasCR = false;
  const end = content.index! + content[0].length;
  for (let index = end; index < argumentsJSON.length; index++) {
    let character = argumentsJSON[index];
    if (character === '"') break;
    if (character === '\\') {
      const escape = argumentsJSON[++index];
      if (escape === undefined) break;
      if (escape === 'u' && /^[\da-f]{4}$/i.test(argumentsJSON.slice(index + 1, index + 5))) {
        character = String.fromCharCode(parseInt(argumentsJSON.slice(index + 1, index + 5), 16));
        index += 4;
      } else {
        character = ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' } as Record<string, string>)[escape] ?? escape;
      }
    }
    if (!(character.charCodeAt(0) >= 0xdc00 && character.charCodeAt(0) <= 0xdfff)) characters++;
    if (character === '\r') { lineBreaks++; previousWasCR = true; }
    else if (character === '\n') { if (!previousWasCR) lineBreaks++; previousWasCR = false; }
    else previousWasCR = false;
  }
  const lines = Math.max(1, lineBreaks + 1);
  return lines > 1
    ? `Drafting ${path} · ${lines.toLocaleString()} lines`
    : `Drafting ${path} · ${characters.toLocaleString()} characters`;
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

import { validPreviewPort } from './preview-contract.js';
import { validFilesystemPath } from './filesystem-contract.js';
import { validStartupCommand } from './production-policy.js';

export const MAX_WORKSPACE_REQUEST_BYTES = 32 * 1024;
export const MAX_RESTORE_LOG_BYTES = 8192;
const object = value => value && typeof value === 'object' && !Array.isArray(value);

// Recipes contain user-authored shell commands, never interpolated shell source.
// Secrets retain their existing vault binding semantics; raw environment values
// are deliberately not part of saved launch metadata.
export function normalizeRestoreLaunch(value) {
  if (!object(value) || Object.keys(value).some(key => !['command', 'cwd', 'readiness'].includes(key)) ||
      !validStartupCommand(value.command) || !value.command.trim() || !object(value.readiness)) return null;
  const cwd = value.cwd === undefined ? '/workspace' : value.cwd;
  const path = value.readiness.path === undefined ? '/' : value.readiness.path;
  const timeoutMs = value.readiness.timeoutMs === undefined ? 30_000 : value.readiness.timeoutMs;
  if (typeof cwd !== 'string' || cwd.length > 1024 || !validFilesystemPath(cwd, true) ||
      Object.keys(value.readiness).some(key => !['port', 'path', 'timeoutMs'].includes(key)) || !validPreviewPort(value.readiness.port) ||
      typeof path !== 'string' || path.length > 1024 || !path.startsWith('/') || path.startsWith('//') || /[\s\\#\x00-\x1f\x7f]/.test(path) ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60_000) return null;
  try { if (new URL(path, 'http://localhost').origin !== 'http://localhost') return null; } catch { return null; }
  return { command: value.command, cwd, readiness: { port: value.readiness.port, path, timeoutMs } };
}

// The same PID-1 supervision pattern as Production, with a deliberate difference:
// restore runs the command once. A failed recipe remains inspectable, and polling
// or replaying a restore must never execute it again.
export function restoreEntrypoint(launch, logPath) {
  return ['sh', '-c', `trap 'kill -TERM "$child" "$logger" 2>/dev/null; exit' TERM INT
umask 077
: > "$3"
mkfifo "$3.pipe" || exit 125
(
  while :; do
    dd bs=8192 count=128 > "$3" 2>/dev/null
    if [ ! -s "$3" ]; then
      if [ -f "$3.previous" ]; then mv -f "$3.previous" "$3"; fi
      break
    fi
    mv -f "$3" "$3.previous"
  done
) < "$3.pipe" & logger=$!
(
  cd "$2" || exit 125
  exec sh -lc "$1"
) > "$3.pipe" 2>&1 & child=$!
wait "$child"
result=$?
printf '%s\\n' "$result" > "$3.exit"
wait "$logger"
rm -f "$3.pipe"
while :; do sleep 3600 & child=$!; wait "$child"; done`, 'mainbrella-restore', launch.command, launch.cwd, logPath];
}

export function publicRestoreReadiness(readiness) {
  if (!readiness) return undefined;
  const { status, port, path, logPath, checkedAt, error, logTail } = readiness;
  return { status, port, path, logPath, ...(checkedAt ? { checkedAt } : {}), ...(error ? { error } : {}), ...(logTail ? { logTail } : {}) };
}

async function bounded(controller, work, timeoutMs, abort) {
  let timer;
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      timer = controller.setTimer(() => { abort?.abort(); reject(new Error('readiness_timeout')); }, timeoutMs);
    })]);
  } finally { if (timer !== undefined) controller.clearTimer(timer); }
}

async function diagnostics(controller, logPath, original) {
  try {
    const work = (async () => {
      const process = await controller.serialized(async () => {
        const metadata = await controller.ctx.storage.get('builderMachine');
        if (!controller.container.running || metadata?.createdAt !== original.createdAt || metadata.telemetryId !== original.telemetryId) return null;
        return bounded(controller, controller.container.exec(['timeout', '--signal=TERM', '--kill-after=1', '2', 'sh', '-c',
          'code=$(head -c 16 "$1.exit" 2>/dev/null); printf "%s\\n" "$code"; cat "$1.previous" "$1" 2>/dev/null | tail -c 8192', 'restore-diagnostics', logPath]), 1500);
      });
      if (!process) return { stdout: '' };
      return process.output();
    })();
    const output = await bounded(controller, work, 2000);
    const raw = output.stdout;
    const text = typeof raw === 'string' ? raw : raw instanceof ArrayBuffer || ArrayBuffer.isView(raw) ? new TextDecoder().decode(raw) : '';
    const newline = text.indexOf('\n');
    const code = text.slice(0, newline).trim();
    const log = text.slice(newline + 1);
    // Drop an incomplete leading UTF-8 sequence instead of expanding it into a
    // replacement character that could exceed the byte limit.
    let bytes = new TextEncoder().encode(log).slice(-MAX_RESTORE_LOG_BYTES);
    while (bytes.length && bytes[0] >= 128 && bytes[0] < 192) bytes = bytes.slice(1);
    const logTail = new TextDecoder().decode(bytes);
    return { exited: /^\d+$/.test(code), logTail };
  } catch { return { exited: false, logTail: '' }; }
}

// Observes only: it never runs/restarts the application. Requests and delays are
// outside the controller/account locks; each metadata commit fences the exact
// generation and incarnation, including a late response after deletion/reuse.
export async function observeRestoreReadiness(controller, original) {
  const current = () => controller.serialized(async () => {
    const metadata = await controller.ctx.storage.get('builderMachine');
    return controller.container.running && metadata?.createdAt === original.createdAt && metadata.telemetryId === original.telemetryId &&
      metadata.readiness?.status === 'starting' ? metadata : null;
  });
  const finish = (status, error, logTail = '') => controller.serialized(async () => {
    const metadata = await controller.ctx.storage.get('builderMachine');
    if (!controller.container.running || metadata?.createdAt !== original.createdAt || metadata.telemetryId !== original.telemetryId || metadata.readiness?.status !== 'starting') return;
    if (status === 'ready' && controller.now() >= metadata.readiness.deadlineAt) { status = 'failed'; error = 'readiness_timeout'; }
    metadata.readiness = { ...metadata.readiness, status, checkedAt: new Date(controller.now()).toISOString(),
      ...(error ? { error } : {}), ...(status === 'failed' && logTail ? { logTail } : {}) };
    await controller.ctx.storage.put('builderMachine', metadata);
    controller.onRestoreReadiness?.(metadata.createdAt);
  });
  for (;;) {
    const metadata = await current();
    if (!metadata) return;
    const remaining = metadata.readiness.deadlineAt - controller.now();
    if (remaining <= 0) {
      const log = controller.now() < controller.deadline(metadata) ? await diagnostics(controller, metadata.readiness.logPath, original) : { exited: false, logTail: '' };
      return finish('failed', log.exited ? 'launch_exited' : 'readiness_timeout', log.logTail);
    }
    const abort = new AbortController();
    let ready = false;
    try {
      const response = await bounded(controller, Promise.resolve(controller.container.getTcpPort(metadata.readiness.port).fetch(
        new Request(`http://localhost${metadata.readiness.path}`, { redirect: 'manual', signal: abort.signal }))), Math.min(2000, remaining), abort);
      ready = response.status >= 200 && response.status < 300;
      response.body?.cancel().catch(() => {});
    } catch { /* Connection refusal and non-2xx responses remain pending until the saved deadline. */ }
    finally { abort.abort(); }
    // A command that exits, even successfully, is not a ready foreground app.
    const log = await diagnostics(controller, metadata.readiness.logPath, original);
    if (log.exited) return finish('failed', 'launch_exited', log.logTail);
    if (ready) return finish('ready', undefined, log.logTail);
    await new Promise(resolve => controller.setTimer(resolve, Math.min(250, Math.max(1, metadata.readiness.deadlineAt - controller.now()))));
  }
}

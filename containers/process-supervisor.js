// GNU timeout creates a process group. The provider's native kill/AbortSignal
// reaches only the launched process, so cancellation must signal that group.
// A guest can deliberately escape a process group; the machine lease remains
// the boundary for those detached processes. This is not a per-job cgroup.
export async function startOperationProcess(controller, createdAt, expiresAt, argv, options, timeoutMs) {
  const source = options.signal;
  const startup = new AbortController();
  let raw, exited = false, disposed = false, cancelRequested = false, cancellation;
  const groupSignal = signal => {
    if (disposed) return Promise.resolve(false);
    if (Number.isSafeInteger(raw?.pid) && raw.pid > 1 && controller.signalOperationGroup) {
      return controller.signalOperationGroup(createdAt, raw.pid, signal);
    }
    // Compatibility for test adapters without a process ID. Production ExecProcess
    // always supplies pid; no public API accepts an arbitrary PID for signaling.
    if (!exited) { try { raw?.kill(signal); } catch {} }
    return Promise.resolve(true);
  };
  const cancel = () => {
    if (disposed || cancelRequested) return;
    cancelRequested = true;
    if (raw) cancellation = groupSignal(9).catch(() => false);
    else startup.abort();
  };
  source?.addEventListener('abort', cancel, { once: true });
  if (source?.aborted) cancel();
  try {
    raw = await controller.startTerminalProcess(createdAt, expiresAt,
      ['timeout', '--signal=KILL', `${Math.max(1, timeoutMs) / 1000}s`, ...argv], { ...options, signal: startup.signal });
    if (cancelRequested) cancellation = groupSignal(9).catch(() => false);
    const exitCode = raw.exitCode.then(code => { exited = true; return code; });
    return { stdin: raw.stdin, stdout: raw.stdout, stderr: raw.stderr, pid: raw.pid, isPty: raw.isPty, exitCode,
      kill: cancel, signal: groupSignal,
      resize: (cols, rows) => { if (disposed || exited || !raw.isPty) throw new Error('pty_unavailable'); raw.resize(cols, rows); },
      async dispose() {
        source?.removeEventListener('abort', cancel);
        const confirmed = cancellation ? await cancellation : true;
        disposed = true;
        return confirmed;
      },
    };
  } catch (error) { source?.removeEventListener('abort', cancel); throw error; }
}

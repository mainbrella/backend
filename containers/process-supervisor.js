// GNU timeout owns the guest process group. ExecProcess.pid may instead name a
// provider/host process, so it must never be used as a guest signal target.
// Detached guest processes remain bounded by the machine lease, not a job cgroup.
const GROUP_WRAPPER = `
group="$PPID"
if [ -r "/proc/$$/stat" ]; then
  IFS= read -r value < "/proc/$$/stat" || exit 125
  value="\${value##*) }"
  read -r state parent group rest <<< "$value"
fi
[[ "$group" =~ ^[0-9]+$ ]] && [ "$group" -gt 1 ] || exit 125
printf '\\036mainbrella-group:%s:%s\\037\\n' "$1" "$group"
shift
exec "$@"
`;

// Provider cleanup can fail to settle as well as reject. A missing confirmation
// retains ownership; the pending fenced cleanup may still finish afterwards.
export async function cleanupWithin(work) {
  let timer;
  try { return await Promise.race([Promise.resolve(work).catch(() => false), new Promise(resolve => { timer = setTimeout(() => resolve(false), 10_000); })]); }
  finally { clearTimeout(timer); }
}

async function guestGroup(stream, nonce, setReader) {
  if (!stream) throw new Error('operation_group_unavailable');
  const reader = stream.getReader();
  setReader(reader);
  const prefix = `\x1emainbrella-group:${nonce}:`;
  let header = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error('operation_group_unavailable');
    const newline = value.indexOf(10);
    const end = newline === -1 ? value.length : newline;
    if (header.length + end > 128) throw new Error('operation_group_unavailable');
    header.push(...value.subarray(0, end));
    if (newline === -1) continue;
    // PTYs translate LF to CRLF. Strip only the handshake's optional CR;
    // everything following its LF remains byte-for-byte guest output.
    if (header.at(-1) === 13) header.pop();
    const text = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(header));
    const suffix = text.startsWith(prefix) && text.slice(prefix.length);
    if (!suffix || !/^[1-9][0-9]*\x1f$/.test(suffix)) throw new Error('operation_group_unavailable');
    const groupId = Number(suffix.slice(0, -1));
    if (!Number.isSafeInteger(groupId) || groupId <= 1) throw new Error('operation_group_unavailable');
    let remainder = value.subarray(newline + 1);
    const stdout = new ReadableStream({
      async pull(controller) {
        if (remainder?.length) { controller.enqueue(remainder); remainder = null; return; }
        remainder = null;
        const next = await reader.read();
        if (next.done) controller.close(); else controller.enqueue(next.value);
      },
      cancel(reason) { return reader.cancel(reason); },
    });
    return { groupId, stdout };
  }
}

// A failed cleanup keeps its existing admission slot. Lifecycle cleanup can
// retry it; the controller's generation marker also fences admission/recovery.
export async function finishOperationProcess(controller, createdAt, process, active, session, onConfirmed) {
  const finish = async () => { await onConfirmed?.(); active.delete(session); return true; };
  const confirmed = await process?.dispose?.().catch(() => false);
  if (confirmed !== false) return finish();
  const close = session.close;
  let cleaning;
  session.close = () => {
    if (cleaning) return cleaning;
    cleaning = Promise.resolve().then(async () => {
      await close();
      if (await cleanupWithin(controller.stopOperationGeneration?.(createdAt, process.incarnation))) return finish();
      return false;
    }).catch(() => false).finally(() => { cleaning = undefined; });
    controller.ctx?.waitUntil(cleaning);
    return cleaning;
  };
  return false;
}

export function startOperationProcess(controller, createdAt, expiresAt, argv, options, timeoutMs, incarnation) {
  const source = options.signal;
  if (source?.aborted) return Promise.reject(new Error('operation_cancelled'));
  const startup = new AbortController();
  // Only legacy host adapters lack group signaling. Production always derives
  // identity from the guest handshake, even when the provider supplies a PID.
  const supervised = typeof controller.signalOperationGroup === 'function';
  const nonce = supervised ? crypto.randomUUID() : null;
  let groupId, stdout, reader, handle, exitCode;
  let raw, exited = false, disposed = false, cancelRequested = false, cancellation;
  let identityAvailable, resolveIdentity;
  const identity = new Promise(resolve => { resolveIdentity = resolve; });
  const identified = available => { if (identityAvailable !== undefined) return; identityAvailable = available; resolveIdentity(available); };
  const stopGeneration = async () => controller.stopOperationGeneration
    ? await controller.stopOperationGeneration(createdAt, incarnation).catch(() => false) : false;
  const groupSignal = signal => {
    if (disposed) return Promise.resolve(false);
    if (supervised) return groupId ? controller.signalOperationGroup(createdAt, groupId, signal, incarnation) : Promise.resolve(false);
    if (!exited) { try { raw?.kill(signal); } catch {} }
    return Promise.resolve(true);
  };
  const cancel = () => {
    if (disposed || cancelRequested) return;
    cancelRequested = true;
    if (!supervised && !raw) startup.abort();
    cancellation = Promise.resolve().then(async () => {
      // A healthy bootstrap is still allowed to report its group after an
      // early cancel. Killing its output first would unnecessarily stop the VM.
      // The startup deadline or a failed header resolves this wait failclosed.
      if (supervised && !await identity) {
        startup.abort();
        try { raw?.kill(9); } catch {}
        void reader?.cancel().catch(() => {});
      }
      const confirmed = await cleanupWithin(groupSignal(9));
      return confirmed || supervised && await cleanupWithin(stopGeneration());
    });
  };
  source?.addEventListener('abort', cancel, { once: true });
  const startupTimer = supervised ? setTimeout(() => { identified(false); cancel(); }, Math.max(1, Math.min(10_000, timeoutMs))) : null;
  // Install even before native exec returns: rejected/aborted startup can still
  // have launched a workload whose cleanup has not been confirmed.
  handle = { get stdin() { return raw?.stdin; }, get stdout() { return stdout ?? raw?.stdout; }, get stderr() { return raw?.stderr; },
    get pid() { return raw?.pid; }, get groupId() { return groupId; }, incarnation, get isPty() { return raw?.isPty; }, get exitCode() { return exitCode; },
    kill: cancel, signal: groupSignal,
    resize: (cols, rows) => { if (disposed || exited || !raw?.isPty) throw new Error('pty_unavailable'); raw.resize(cols, rows); },
    async dispose() {
      // Even a successful direct-child exit may leave descendants in its group.
      if (supervised) cancel();
      source?.removeEventListener('abort', cancel);
      const confirmed = cancellation ? await cancellation : true;
      disposed = confirmed;
      return confirmed;
    },
  };
  const starting = (async () => { try {
    raw = await controller.startTerminalProcess(createdAt, expiresAt,
      ['timeout', '--signal=KILL', `${Math.max(1, timeoutMs) / 1000}s`,
        ...(supervised ? ['/bin/bash', '-c', GROUP_WRAPPER, 'mainbrella-operation', nonce, ...argv] : argv)],
      { ...options, signal: startup.signal }, { incarnation });
    if (cancelRequested && (!supervised || identityAvailable === false)) { try { raw.kill(9); } catch {} throw new Error('operation_cancelled'); }
    exitCode = raw.exitCode.then(code => { exited = true; return code; });
    if (supervised) {
      const guest = await guestGroup(raw.stdout, nonce, value => { reader = value; });
      groupId = guest.groupId; stdout = guest.stdout;
      identified(true);
    }
    if (cancelRequested) throw new Error('operation_cancelled');
    return handle;
  } catch (error) {
    identified(false);
    cancel();
    const confirmed = cancellation ? await cancellation : !supervised;
    if (!confirmed && handle) error.operationProcess = handle;
    void reader?.cancel().catch(() => {});
    source?.removeEventListener('abort', cancel);
    throw error;
  } finally { clearTimeout(startupTimer); } })();
  // Private startup ownership is available immediately to callers racing a
  // deadline, while the public process is returned only after guest identity.
  Object.defineProperty(starting, 'operationProcess', { value: handle });
  return starting;
}

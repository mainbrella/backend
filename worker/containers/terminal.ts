// Import into the existing private UserContainer Worker. Keep one bridge per DO
// instance, and pass the current server-owned lease from its lifecycle storage.
export class ContainerTerminal {
  private sessions = 0;

  async fetch(request: Request, container: Container | undefined, leaseExpiresAt: number): Promise<Response> {
    if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket required', { status: 426 });
    }
    if (!container?.running || !Number.isFinite(leaseExpiresAt) || leaseExpiresAt <= Date.now()) {
      return new Response('Container is not running', { status: 409 });
    }
    if (this.sessions >= 4) return new Response('Too many terminals', { status: 429 });
    this.sessions++;
    let process: ExecProcess;
    try {
      process = await container.exec(['/bin/bash', '-l'], {
        pty: true, stdin: 'pipe', stdout: 'pipe', stderr: 'combined',
        env: { TERM: 'xterm-256color', HOME: '/root', LANG: 'C.UTF-8' },
      });
    } catch {
      this.sessions--;
      return new Response('Terminal unavailable', { status: 503 });
    }
    const pair = new WebSocketPair();
    const socket = pair[1];
    socket.accept(); // Active streams require a non-hibernating WebSocket.
    const writer = process.stdin!.getWriter();
    const reader = process.stdout!.getReader();
    let ended = false;
    let exited = false;
    let pendingBytes = 0;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (code = 1000, reason = 'Terminal closed') => {
      if (ended) return;
      ended = true;
      this.sessions--;
      clearTimeout(timer);
      if (!exited) { try { process.kill(9); } catch { /* Container may already be stopped. */ } }
      void writer.abort().catch(() => {});
      void reader.cancel().catch(() => {});
      try { socket.close(code, reason); } catch { /* Peer already disconnected. */ }
    };
    timer = setTimeout(() => finish(1000, 'Terminal session expired'), Math.max(1, Math.min(leaseExpiresAt - Date.now(), 15 * 60_000)));
    socket.addEventListener('close', () => finish());
    socket.addEventListener('error', () => finish(1011, 'Connection failed'));
    socket.addEventListener('message', (event) => {
      if (ended) return;
      try {
        if (typeof event.data !== 'string' || event.data.length > 65536) throw new Error('invalid_frame');
        const frame = JSON.parse(event.data);
        if (frame.type === 'resize') {
          if (!Number.isInteger(frame.cols) || !Number.isInteger(frame.rows)
            || frame.cols < 1 || frame.cols > 500 || frame.rows < 1 || frame.rows > 200) throw new Error('invalid_size');
          if (!exited) process.resize(frame.cols, frame.rows);
        } else if (frame.type === 'input' && typeof frame.data === 'string') {
          const bytes = new TextEncoder().encode(frame.data);
          pendingBytes += bytes.byteLength;
          if (pendingBytes > 262144) throw new Error('input_overflow');
          void writer.write(bytes).then(() => { pendingBytes -= bytes.byteLength; }, () => finish(1011, 'Input failed'));
        } else throw new Error('invalid_frame');
      } catch { finish(1008, 'Invalid terminal message'); }
    });
    // Mark completion before any disconnect handler can signal an exited process.
    void process.exitCode.then(() => { exited = true; clearTimeout(timer); }, () => finish(1011, 'Process failed'));
    void (async () => {
      try {
        while (!ended) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!ended) socket.send(value);
        }
        const exitCode = await process.exitCode;
        exited = true;
        if (!ended) socket.send(JSON.stringify({ type: 'exit', code: exitCode }));
        finish();
      } catch { finish(1011, 'Terminal failed'); }
    })();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
}
